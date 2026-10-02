import { XMLParser, XMLValidator } from 'fast-xml-parser';
export type FieldKind = 'number' | 'string' | 'date' | 'boolean';
export type Field = { name: string; kind: FieldKind };
export type Rule = { field: string; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'null'|'notnull'|'in'|'notin'; value?: string; values?: string[] };
export type Feature = { id?: string|number; geometry: {type: string; coordinates: number[]}; properties: Record<string,unknown> };
export type Page = { features: Feature[]; numberMatched?: number };
export const xmlParser = new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, attributeNamePrefix:'@_', parseTagValue:false });
export function xmlDocument(text: string): any {
  if(XMLValidator.validate(text)!==true) throw new Error('Server returned malformed XML');
  const obj=xmlParser.parse(text);
  if(obj.ExceptionReport || obj.ServiceExceptionReport) throw new Error('WFS exception: '+text.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,500));
  return obj;
}
export function countFrom(text: string): number|undefined {
  const obj=xmlDocument(text), fc=obj.FeatureCollection;
  const n=Number(fc?.['@_numberMatched'] ?? fc?.['@_numberOfFeatures']);
  return Number.isSafeInteger(n) && n>=0 ? n : undefined;
}
const list = (v:any):any[] => v==null ? [] : Array.isArray(v) ? v : [v];
export function decodePage(text: string, axis: 'xy'|'yx'='xy'): Page {
  if(text.trimStart().startsWith('{')) {
    const data=JSON.parse(text);
    if(data.type!=='FeatureCollection' || !Array.isArray(data.features)) throw new Error('Expected a GeoJSON FeatureCollection');
    // GeoJSON always uses longitude, latitude, regardless of requested WFS CRS.
    const n=Number(data.numberMatched ?? data.totalFeatures);
    // Some production services encode individual observations as MultiPoint.
    // A singleton still represents exactly one row; never drop extra points.
    for (const f of data.features) {
      if (f.geometry?.type !== 'MultiPoint') continue;
      if (f.geometry.coordinates?.length !== 1) throw new Error('Only single-point MultiPoint features are supported; multiple locations cannot represent one observation');
      f.geometry = { type: 'Point', coordinates: f.geometry.coordinates[0] };
    }
    return {features:data.features,numberMatched:Number.isSafeInteger(n)&&n>=0?n:undefined};
  }
  const fc=xmlDocument(text).FeatureCollection;
  if(!fc) throw new Error('Expected a GML FeatureCollection');
  const members=[...list(fc.member),...list(fc.featureMember),...list(fc.featureMembers).flatMap(m=>Object.entries(m).filter(([k])=>!k.startsWith('@_')).flatMap(([k,v])=>list(v).map(x=>({[k]:x}))))];
  const features:Feature[]=members.map(m=>{
    const entry=Object.entries(m).find(([k])=>!k.startsWith('@_'));
    if(!entry) throw new Error('Empty GML member');
    const f=entry[1] as any;
    const properties:Record<string,unknown>={};
    let coordinates:number[]|undefined;
    for(const [key,val] of Object.entries(f)) {
      if(key.startsWith('@_') || key==='boundedBy') continue;
      const multi=(val as any)?.MultiPoint;
      const points=multi ? [...list(multi.pointMember).flatMap(m=>list(m.Point)),...list(multi.pointMembers).flatMap(m=>list(m.Point))] : [];
      if(multi && points.length!==1) throw new Error('Only single-point GML MultiPoint features are supported');
      const point=(val as any)?.Point ?? points[0];
      if(point) {
        const pos=point.pos ?? point.coordinates;
        const raw=typeof pos==='object' ? pos['#text'] : pos;
        coordinates=String(raw).trim().split(/[\s,]+/).map(Number);
        if(axis==='yx') coordinates=[coordinates[1],coordinates[0],...coordinates.slice(2)];
      } else if((val as any)?.['@_nil']==='true') properties[key]=null;
      else properties[key]=typeof val==='object' && val && '#text' in val ? (val as any)['#text'] : val;
    }
    if(!coordinates) throw new Error('Only GML Point geometries with pos/coordinates are supported');
    return {id:f['@_id'] ?? f['@_fid'],geometry:{type:'Point',coordinates},properties};
  });
  // In WFS 1.x numberOfFeatures counts the returned page (except for hits).
  // Treating it as the matched total breaks every multi-page GML 1.x load.
  const n=Number(fc['@_numberMatched']);
  return {features,numberMatched:Number.isSafeInteger(n)&&n>=0?n:undefined};
}
export function fieldKind(type: string): FieldKind {
  if(/date|time/i.test(type)) return 'date';
  if(/bool/i.test(type)) return 'boolean';
  if(/int|float|double|decimal|long|short|byte/i.test(type)) return 'number';
  return 'string';
}
export function inferFields(features:Feature[], hints:Field[]=[]):Field[] {
  const result=new Map(hints.map(f=>[f.name,f.kind]));
  for(const f of features) for(const [name,v] of Object.entries(f.properties ?? {})) {
    if(!result.has(name) && v!=null) result.set(name, typeof v==='number'?'number':typeof v==='boolean'?'boolean':typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?'date':'string');
  }
  for(const f of features) for(const name of Object.keys(f.properties ?? {})) if(!result.has(name)) result.set(name,'string');
  return [...result].map(([name,kind])=>({name,kind}));
}
export function numericValue(v:unknown, kind:FieldKind):number {
  if(v==null) return NaN;
  if(kind==='boolean') {
    if(v===true || v==='true' || v===1 || v==='1') return 1;
    if(v===false || v==='false' || v===0 || v==='0') return 0;
    throw new Error(`Invalid boolean ${String(v)}`);
  }
  const n=kind==='date'?Date.parse(String(v)):typeof v==='string'&&v.trim()===''?NaN:Number(v);
  if(!Number.isFinite(n)) throw new Error(`Invalid ${kind}: ${String(v)}`);
  return n;
}
export function toText(v:unknown):string { return typeof v==='object'?JSON.stringify(v):String(v); }
export function mercator(lon:number,lat:number):[number,number] {
  if(!Number.isFinite(lon)||!Number.isFinite(lat)||lon < -180||lon>180||lat < -85.05112878||lat>85.05112878) throw new Error('Coordinate outside Web Mercator range; request CRS84 or check GML axis order');
  return [(lon+180)/360,(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2];
}
export function packPositions(features:Feature[]):Float32Array {
  const out=new Float32Array(features.length*4);
  for(let i=0;i<features.length;i++) {
    const f=features[i];
    if(f.geometry?.type!=='Point') throw new Error('This proof of concept supports Point geometries only');
    const [x,y]=mercator(f.geometry.coordinates[0],f.geometry.coordinates[1]);
    const hx=Math.fround(x), hy=Math.fround(y);
    out.set([hx,hy,x-hx,y-hy],i*4);
  }
  return out;
}
export function spatialPage(positions:Float32Array, offset:number) {
  // Each page is bucketed in a 32 x 32 grid, retaining original feature IDs.
  // Bounds describe actual points, so outliers and page-to-page extent changes are safe.
  const n=positions.length/4, counts=new Uint32Array(1024), cells=new Uint16Array(n);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=0;i<n;i++) {const x=positions[i*4]+positions[i*4+2],y=positions[i*4+1]+positions[i*4+3];minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  const dx=maxX-minX||1,dy=maxY-minY||1,bounds=new Float64Array(4096);
  for(let c=0;c<1024;c++)bounds.set([Infinity,Infinity,-Infinity,-Infinity],c*4);
  for(let i=0;i<n;i++) {
    const x=positions[i*4]+positions[i*4+2],y=positions[i*4+1]+positions[i*4+3];
    const c=Math.min(31,Math.floor((y-minY)/dy*32))*32+Math.min(31,Math.floor((x-minX)/dx*32));
    cells[i]=c;counts[c]++;bounds[c*4]=Math.min(bounds[c*4],x);bounds[c*4+1]=Math.min(bounds[c*4+1],y);bounds[c*4+2]=Math.max(bounds[c*4+2],x);bounds[c*4+3]=Math.max(bounds[c*4+3],y);
  }
  const starts=new Uint32Array(1024),groups:number[]=[];let cursor=0;
  for(let c=0;c<1024;c++) {starts[c]=cursor;if(counts[c])groups.push(offset+cursor,counts[c],...bounds.subarray(c*4,c*4+4));cursor+=counts[c];}
  const indices=new Uint32Array(n);
  for(let i=0;i<n;i++)indices[starts[cells[i]]++]=offset+i;
  return {indices,groups:new Float64Array(groups)};
}
export function wfsURL(base:string, version:string, operation:string, params:Record<string,string>={}):string {
  const u=new URL(base);
  // Keep vendor arguments and auth tokens, replace reserved parameters case insensitively.
  const values={service:'WFS',version,request:operation,...params};
  for(const name of Object.keys(values)) for(const key of [...u.searchParams.keys()]) if(key.toLowerCase()===name.toLowerCase()) u.searchParams.delete(key);
  for(const [key,value] of Object.entries(values)) u.searchParams.set(key,value);
  return u.href;
}
