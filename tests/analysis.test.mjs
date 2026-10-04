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
  await assert.rejects(a.run(all([]),[{id:'a',type:'scatter',x:'missing',y:'value',bins:24}]),/known attributes/);
  await assert.rejects(a.run(all([]),[{id:'a',type:'time',x:'value',bins:24}]),/date attribute/);
});
test('numeric boundary rounding, huge finite values and subnormals preserve exact click membership',async()=>{
  for(const values of [[1,2,3,4,5,6,7,8,9],[-1.7e308,0,1.7e308],[0,Number.MIN_VALUE,Number.MIN_VALUE*2]]){
    const rows=values.map((n,i)=>({...feature(i),properties:{n}})),a=build(rows),r=await a.run(all([]),[{id:'n',type:'bar',x:'n',bins:24}]);
    assert.equal(r.charts[0].counts.reduce((a,b)=>a+b,0),rows.length);
    for(let i=0;i<24;i++)assert.equal((await a.run(r.charts[0].x.rules[i],[])).count,r.charts[0].counts[i],`values ${values} bin ${i}`);
  }
});
test('geographic filters compose with attribute AND/OR, include edges and cross the antimeridian',async()=>{
  const coords=[[-179,0],[179,0],[0,0],[10,10],[-10,-10],[10,11]],rows=coords.map((coordinates,i)=>({...feature(i),geometry:{type:'Point',coordinates}})),a=build(rows);
  assert.deepEqual([...(await a.run({op:'bbox',west:170,east:-170,south:-1,north:1},[])).indices],[0,1]);
  const box={op:'bbox',west:-10,east:10,south:-10,north:10};
  assert.deepEqual([...(await a.run({op:'and',children:[box,{field:'id',op:'gte',value:'3'}]},[])).indices],[3,4]);
  assert.equal((await a.run({op:'or',children:[box,{op:'row',index:0}]},[])).count,4);
  await assert.rejects(a.run({...box,north:-20},[]),/geographic/);
});
test('time Y aggregates stay binned, and only scatter accepts unbinned observations',async()=>{
  const rows=Array.from({length:10},(_,i)=>({...feature(i),properties:{x:i%3,time:new Date(1704067200000+(i%3)*1000).toISOString(),y:i===9?null:i-5,text:`c${i%3}`}})),a=build(rows);
  for(const aggregate of ['count','sum','mean','min','max']){
    const r=(await a.run(all([]),[{id:'t',type:'time',x:'time',y:'y',aggregate,bins:8,binned:false}])).charts[0];assert.ok(r.x.ranges);assert.equal(r.missing,aggregate==='count'?0:1);
    for(let j=0;j<r.counts.length;j++){const range=r.x.rules[j].children,selected=rows.filter(f=>{const x=Date.parse(f.properties.time);return x>=Date.parse(range[0].value)&&(range[1].op==='lt'?x<Date.parse(range[1].value):x<=Date.parse(range[1].value));});assert.equal((await a.run(r.x.rules[j],[])).count,selected.length);if(aggregate!=='count'){const ys=selected.map(f=>f.properties.y).filter(v=>v!==null),sum=ys.reduce((a,b)=>a+b,0);assert.equal(r.values[j],!ys.length?NaN:aggregate==='sum'?sum:aggregate==='mean'?sum/ys.length:aggregate==='min'?Math.min(...ys):Math.max(...ys));}}
  }
  for(const type of ['bar','pie']){const r=(await a.run(all([]),[{id:type,type,x:'x',bins:8,binned:false}])).charts[0];assert.ok(r.x.ranges);assert.equal(r.counts.length,8);}
  const r=(await a.run(all([]),[{id:'s',type:'scatter',x:'x',y:'y',bins:8,binned:false}])).charts[0];assert.equal(r.raw.rows.length,9);assert.equal(r.raw.positions.length,18);assert.equal(r.missing,1);assert.deepEqual([...r.raw.rows],[0,1,2,3,4,5,6,7,8]);assert.equal((await a.run({op:'row',index:r.raw.rows[5]},[])).count,1);
});
test('non-scatter charts remain bounded; colours use fixed full-data bins and missing codes',async()=>{
  const rows=Array.from({length:4100},(_,i)=>({...feature(i),properties:{x:i,y:i===0?null:i,time:new Date(1704067200000+i).toISOString()}})),a=build(rows);
  const r=await a.run(all([]),[{id:'exact',type:'bar',x:'x',bins:8,binned:false},{id:'binned',type:'bar',x:'x',bins:8}]);assert.equal(r.charts[0].error,undefined);assert.equal(r.charts[0].counts.length,8);assert.equal(r.count,4100);assert.equal(r.charts[1].counts.reduce((a,b)=>a+b,0),4100);
  const colors=await a.colors('y',8);assert.equal(colors.codes.byteLength,4100);assert.equal(colors.codes[0],255);assert.equal(colors.codes[1],0);assert.equal(colors.codes.at(-1),7);for(let i=0;i<8;i++){const n=(await a.run(colors.axis.rules[i],[])).count;assert.equal(colors.codes.filter(v=>v===i).length,n);}
  await assert.rejects(a.colors('y',8,()=>true),/Superseded/);
});
test('unbinned date coordinates retain millisecond separation across multi-year domains',async()=>{
 const base=Date.UTC(2024,0,1),dates=[base,base+31536000000,base+31536000001,base+63072000000],a=build(dates.map((time,i)=>({...feature(i),properties:{time:new Date(time).toISOString(),y:i}})));
 const r=(await a.run(all([]),[{id:'s',type:'scatter',x:'time',y:'y',bins:8,binned:false}])).charts[0];assert.equal(r.raw.precise,true);assert.equal(r.raw.positions.length,16);
 const x=i=>r.raw.positions[i*4]+r.raw.positions[i*4+2];assert.ok(x(2)>x(1));assert.ok(Math.abs((x(2)-x(1))*63072000000/2-1)<.001);
});


test('discrete colours cover every unique string, preserve missing values, and remain stable through filtering/reordering', async () => {
  const { categoryColors, colorBytes } = await import('../src/category-colors.ts');
  const names = [...Array.from({length:300}, (_, i) => `category-${i}`), '', '__proto__', '<img src=x>'];
  const rows = [...names, names[0], null].map((name, i) => ({...feature(i), properties:{name, value:i, date:'2026-10-01T00:00:00Z', flag:true}}));
  const analyzer = build(rows), result = await analyzer.colors('name', 8);
  assert.equal(result.categories.length, names.length);
  assert.equal(result.codes.byteLength, rows.length * 3);
  const palette = categoryColors(names); assert.equal(new Set(palette.values()).size, names.length);
  for (let i = 0; i < names.length; i++) assert.deepEqual([...result.codes.slice(i*3,i*3+3)], colorBytes(palette.get(names[i])));
  assert.deepEqual([...result.codes.slice(-3)], [128,128,128]);
  assert.deepEqual([...result.codes.slice(names.length*3,names.length*3+3)], [...result.codes.slice(0,3)]);
  await analyzer.run({field:'name',op:'eq',value:names[0]}, []);
  assert.deepEqual((await analyzer.colors('name',64)).codes,result.codes);
  const overrides = JSON.parse('{"__proto__":"#ff00ff","category-0":"#00ff00"}');
  const changed = await analyzer.colors('name',8,() => false,overrides);
  assert.deepEqual([...changed.codes.slice(0,3)],[0,255,0]);
  assert.deepEqual([...changed.codes.slice(301*3,302*3)],[255,0,255]);
  const reordered = await build([...rows].reverse()).colors('name',8);
  for (let i = 0; i < rows.length; i++) assert.deepEqual([...reordered.codes.slice(i*3,i*3+3)], [...result.codes.slice((rows.length-i-1)*3,(rows.length-i)*3)]);
  await assert.rejects(analyzer.colors('name',8,() => true),/Superseded/);
  await assert.rejects(analyzer.colors('date',8),/numeric field/);
  await assert.rejects(analyzer.colors('flag',8),/numeric field/);
  await assert.rejects(analyzer.colors('absent',8),/Unknown colour attribute/);
});
