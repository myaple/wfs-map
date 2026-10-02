import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, all } from '../src/analysis.ts';
import { Store } from '../src/store.ts';
import { inferFields } from '../src/data.ts';
import { feature } from '../server/demo.ts';
const build=(features)=>{const s=new Store(inferFields(features));for(let i=0;i<features.length;i+=37)s.append(features.slice(i,i+37));s.finish();return new Analyzer(s);};
const matches=(e,p)=>'children' in e?(e.op==='and'?e.children.every(c=>matches(c,p)):e.children.some(c=>matches(c,p))):e.op==='eq'?String(p[e.field])===e.value:e.op==='gte'?p[e.field]>=e.value:e.op==='lt'?p[e.field]<e.value:e.op==='lte'?p[e.field]<=e.value:e.op==='notin'?!e.values.includes(p[e.field]):false;
test('nested AND/OR and empty groups have exact, duplicate-free set semantics across chunks',async()=>{
  const rows=Array.from({length:1024},(_,i)=>feature(i)),a=build(rows);
  const e={op:'and',children:[{op:'or',children:[{field:'category',op:'eq',value:'sensor'},{field:'category',op:'eq',value:'vehicle'}]},{field:'value',op:'gte',value:'50'}]};
  const r=await a.run(e,[]);assert.deepEqual([...r.indices],rows.flatMap((f,i)=>matches(e,f.properties)?[i]:[]));
  assert.equal((await a.run({op:'or',children:[]},[])).count,0);
  assert.equal((await a.run(all([]),[])).indices,null);
  await assert.rejects(a.run({op:'and',children:Array.from({length:129},()=>({field:'id',op:'eq',value:'1'}))},[]),/128 nodes/);
});
test('all four chart types count every match; category and numeric/time/scatter clicks match exact bins',async()=>{
  const rows=Array.from({length:1003},(_,i)=>feature(i)),a=build(rows);
  const specs=[{id:'bar',type:'bar',x:'category',bins:8},{id:'pie',type:'pie',x:'active',bins:8},{id:'time',type:'time',x:'timestamp',bins:24},{id:'scatter',type:'scatter',x:'value',y:'quality',bins:16}];
  const r=await a.run(all([]),specs);
  for(const c of r.charts){assert.equal(c.counts.reduce((a,b)=>a+b,0)+c.missing,rows.length);
    const bins=c.y?[0,17,255]:c.x.rules.map((_,i)=>i);
    for(const index of bins){const nx=c.x.labels.length,e=c.y?{op:'and',children:[c.x.rules[index%nx],c.y.rules[Math.floor(index/nx)]]}:c.x.rules[index];const selected=await a.run(e,[]);assert.equal(selected.count,c.counts[index],`${c.id} bin ${index}`);}
  }
  const filtered=await a.run({field:'category',op:'eq',value:'vehicle'},specs);assert.equal(filtered.count,251);for(const c of filtered.charts)assert.equal(c.counts.reduce((a,b)=>a+b,0)+c.missing,251);
});
test('Other categories is exact and clickable; nulls, constants, and all-null axes are accounted for',async()=>{
  const rows=Array.from({length:80},(_,i)=>({...feature(i),properties:{text:i===0?null:`category-${i%30}`,n:i===0?null:7,time:null,y:i%7}}));
  const a=build(rows),r=await a.run(all([]),[{id:'cat',type:'pie',x:'text',bins:8},{id:'const',type:'bar',x:'n',bins:24},{id:'empty',type:'bar',x:'time',bins:8}]);
  for(const c of r.charts)assert.equal(c.counts.reduce((a,b)=>a+b,0)+c.missing,80);
  assert.equal(r.charts[0].x.labels.at(-1),'Other categories');const other=await a.run(r.charts[0].x.rules.at(-1),[]);assert.equal(other.count,r.charts[0].counts.at(-1));
  assert.equal(r.charts[1].counts.length,1);assert.equal((await a.run(r.charts[1].x.rules[0],[])).count,79);
  assert.equal(r.charts[2].counts.length,0);assert.equal(r.charts[2].missing,80);
});
test('millisecond date boundaries remain exact even when bin widths are fractional',async()=>{
  const rows=Array.from({length:17},(_,i)=>({...feature(i),properties:{time:new Date(1704067200000+i).toISOString()}}));
  const a=build(rows),r=await a.run(all([]),[{id:'time',type:'time',x:'time',bins:24}]);
  for(let i=0;i<24;i++)assert.equal((await a.run(r.charts[0].x.rules[i],[])).count,r.charts[0].counts[i]);
});
test('analysis cancellation and schema validation reject safely',async()=>{
  const a=build(Array.from({length:300},(_,i)=>feature(i)));
  await assert.rejects(a.run(all([]),[{id:'a',type:'bar',x:'value',bins:24}],()=>true),/Superseded/);
  await assert.rejects(a.run(all([]),[{id:'a',type:'scatter',x:'category',y:'value',bins:24}]),/numeric or date/);
  await assert.rejects(a.run(all([]),[{id:'a',type:'time',x:'value',bins:24}]),/date attribute/);
});
test('numeric boundary rounding, huge finite values and subnormals preserve exact click membership',async()=>{
  for(const values of [[1,2,3,4,5,6,7,8,9],[-1.7e308,0,1.7e308],[0,Number.MIN_VALUE,Number.MIN_VALUE*2]]){
    const rows=values.map((n,i)=>({...feature(i),properties:{n}})),a=build(rows),r=await a.run(all([]),[{id:'n',type:'bar',x:'n',bins:24}]);
    assert.equal(r.charts[0].counts.reduce((a,b)=>a+b,0),rows.length);
    for(let i=0;i<24;i++)assert.equal((await a.run(r.charts[0].x.rules[i],[])).count,r.charts[0].counts[i],`values ${values} bin ${i}`);
  }
});
