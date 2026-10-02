import { type Feature, type Field, type Rule, numericValue, toText } from './data.ts';
type Column = {field:Field; dictionary:string[]; codes:Map<string,number>};
type Chunk = { offset:number; length:number; values:(Float64Array|Int32Array)[]; ids:(string|number|null)[]; lon:Float64Array; lat:Float64Array };
export class Store {
  fields:Field[]; columns:Column[]; chunks:Chunk[]=[]; length=0;
  seen=new Set<string>();
  bounds=[Infinity,Infinity,-Infinity,-Infinity];
  constructor(fields:Field[]) { this.fields=fields; this.columns=fields.map(field=>({field,dictionary:[],codes:new Map()})); }
  append(features:Feature[]) {
    const chunk:Chunk={offset:this.length,length:features.length,values:this.columns.map(c=>c.field.kind==='string'?new Int32Array(features.length):new Float64Array(features.length)),ids:[],lon:new Float64Array(features.length),lat:new Float64Array(features.length)};
    const names=new Set(this.fields.map(f=>f.name));
    for(let i=0;i<features.length;i++) {
      const f=features[i], props=f.properties??{};
      if(Object.keys(props).some(k=>!names.has(k))) throw new Error('A new attribute appeared after the first page. Use DescribeFeatureType or choose a larger first page.');
      const id=f.id ?? null;
      if(id!==null) { const key=typeof id+':'+id; if(this.seen.has(key)) throw new Error(`Repeated feature ID ${id}: server pagination is unstable or startIndex is ignored. Use a stable sort field.`); this.seen.add(key); }
      chunk.ids.push(id);
      const [lon,lat]=f.geometry.coordinates;
      chunk.lon[i]=lon; chunk.lat[i]=lat;
      this.bounds[0]=Math.min(this.bounds[0],lon); this.bounds[1]=Math.min(this.bounds[1],lat); this.bounds[2]=Math.max(this.bounds[2],lon); this.bounds[3]=Math.max(this.bounds[3],lat);
      for(let j=0;j<this.columns.length;j++) {
        const c=this.columns[j], v=props[c.field.name];
        if(c.field.kind==='string') {
          if(v==null) { chunk.values[j][i]=-1; continue; }
          const text=toText(v); let code=c.codes.get(text);
          if(code===undefined) {code=c.dictionary.length;c.dictionary.push(text);c.codes.set(text,code);}
          chunk.values[j][i]=code;
        } else chunk.values[j][i]=numericValue(v,c.field.kind);
      }
    }
    this.chunks.push(chunk); this.length+=features.length;
  }
  finish() { this.seen.clear(); for(const c of this.columns) c.codes.clear(); }
  get(index:number) {
    const chunk=this.chunks.find(c=>index>=c.offset&&index<c.offset+c.length);
    if(!chunk) throw new Error('Point index out of bounds');
    const i=index-chunk.offset, properties:Record<string,unknown>={};
    this.columns.forEach((c,j)=>{
      const v=chunk.values[j][i];
      properties[c.field.name]=c.field.kind==='string'?(v<0?null:c.dictionary[v]):Number.isNaN(v)?null:c.field.kind==='date'?new Date(v).toISOString():c.field.kind==='boolean'?Boolean(v):v;
    });
    return {id:chunk.ids[i],coordinates:[chunk.lon[i],chunk.lat[i]],properties};
  }
  async filter(rules:Rule[], cancelled:()=>boolean=()=>false):Promise<Uint32Array|null> {
    if(!rules.length) return null;
    const compiled=rules.map(rule=>{
      const j=this.fields.findIndex(f=>f.name===rule.field);
      if(j<0) throw new Error(`Unknown attribute ${rule.field}`);
      const c=this.columns[j];
      const nullOp=rule.op==='null'||rule.op==='notnull';
      if(!nullOp && rule.value==null) throw new Error('Missing filter value');
      if(rule.op==='contains'&&c.field.kind!=='string') throw new Error('Contains requires a text attribute');
      if(!['eq','ne','gt','gte','lt','lte','contains','null','notnull'].includes(rule.op)) throw new Error('Invalid filter operator');
      const target=c.field.kind==='string'?rule.value!:nullOp?0:numericValue(rule.value,c.field.kind);
      // Evaluate string rules against each dictionary entry once, not per row.
      const pass=c.field.kind==='string'&&!nullOp ? Uint8Array.from(c.dictionary.map(v=>compare(v,target,rule.op)?1:0)) : null;
      return {j,c,rule,target,pass};
    });
    const out=new Uint32Array(this.length); let count=0;
    for(const chunk of this.chunks) {
      for(let base=0;base<chunk.length;base+=16384) {
        for(let i=base;i<Math.min(base+16384,chunk.length);i++) {
          let good=true;
          for(const {j,c,rule,target,pass} of compiled) {
            const v=chunk.values[j][i], missing=c.field.kind==='string'?v<0:Number.isNaN(v);
            const ok=rule.op==='null'?missing:rule.op==='notnull'?!missing:!missing&&(pass?Boolean(pass[v]):compare(v,target,rule.op));
            if(!ok) {good=false;break;}
          }
          if(good) out[count++]=chunk.offset+i;
        }
        // Let new filter requests / cancellation interrupt a long scan.
        await yieldToEvents();
        if(cancelled()) throw new Error('Superseded');
      }
    }
    return out.subarray(0,count);
  }
}
async function yieldToEvents() {
  const scheduler=(globalThis as any).scheduler;
  if(scheduler?.yield) {await scheduler.yield();return;}
  // MessageChannel avoids the 4 ms nesting clamp on repeated setTimeout(0).
  if(typeof MessageChannel!=='undefined') {
    await new Promise<void>(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);});
  } else await new Promise<void>(r=>setTimeout(r,0));
}
function compare(a:any,b:any,op:Rule['op']):boolean {
  switch(op) {case 'eq':return a===b;case 'ne':return a!==b;case 'gt':return a>b;case 'gte':return a>=b;case 'lt':return a<b;case 'lte':return a<=b;case 'contains':return String(a).includes(String(b));default:return false;}
}
