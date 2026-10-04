import test from 'node:test';
import assert from 'node:assert/strict';
import { project,compare,relate,distanceMetres } from '../src/comparison.ts';
import { Store } from '../src/store.ts';
import { emptyState,configurationState } from '../src/analysis-state.ts';
const store=(values,names=['asset','when','temp'])=>{const s=new Store(names.map((name,i)=>({name,kind:['string','date','number'][i]})));s.append(values.map((v,i)=>({id:`row${i}`,geometry:{type:'Point',coordinates:v.slice(3)},properties:Object.fromEntries(names.map((name,k)=>[name,v[k]]))})));s.finish();return s;};
const a=store([['A','2026-10-01T00:00:00Z',0,0,0],['B','2026-10-01T01:00:00Z',10,1,1],['C','2026-10-01T02:00:00Z',20,2,2],['D','2026-10-01T03:00:00Z',null,3,3]]);
const b=store([['A','2026-10-01T00:00:30Z',32,0.0001,0],['A','2026-10-01T00:00:45Z',50,0.0002,0],['B','2026-10-01T01:02:00Z',50,1,1],['X','2026-10-01T02:00:00Z',68,2,2],['A',null,0,0,0]],['station','observed','fahrenheit']);
const series=(id,sourceId,x,unit='C')=>({id,sourceId,label:id,x,unit,scale:1,offset:0,converted:false,filter:{op:'and',children:[]}});
test('comparison uses different fields, explicit unit conversion and shared edges over unequal applied results',async()=>{
 const p=await project(a,'a',new Uint32Array([0,1,2,3]),['temp']);const q=await project(b,'b',null,['fahrenheit']);
 const spec={id:'c',name:'Temperatures',kind:'histogram',unit:'C',bins:2,bucketMs:3600000,aggregate:'count',series:[series('a','a','temp'),{...series('b','b','fahrenheit','F'),converted:true,scale:5/9,offset:-32*5/9}]};
 const result=await compare(spec,new Map([['a',p],['b',q]]));assert.equal(result.edges.length,3);assert.equal(result.series[0].missing,1);assert.equal(result.series[0].counts.reduce((a,b)=>a+b),3);assert.equal(result.series[1].counts.reduce((a,b)=>a+b),5);
 assert.deepEqual(result.series[0].members.flat().sort(),[0,1,2]);
 await assert.rejects(compare({...spec,series:[spec.series[0],{...spec.series[1],converted:false}]},new Map([['a',p],['b',q]])),/conversion/);
});
test('time comparison aligns UTC buckets and converts measures before aggregation, with per-series filters',async()=>{
 const p=await project(a,'a',new Uint32Array([0,1,2]),['when','temp'],{field:'temp',op:'gte',value:'10'});const q=await project(b,'b',new Uint32Array([0,1,2,3]),['observed','fahrenheit']);
 const spec={id:'t',name:'Time',kind:'time',unit:'C',bins:24,bucketMs:3600000,aggregate:'mean',series:[{...series('a','a','when'),y:'temp'},{...series('b','b','observed','F'),y:'fahrenheit',converted:true,scale:5/9,offset:-32*5/9}]};
 const r=await compare(spec,new Map([['a',p],['b',q]]));assert.equal(r.edges[0],Date.parse('2026-10-01T00:00:00Z'));assert.deepEqual(r.series[0].counts,[0,1,1]);assert.deepEqual(r.series[0].values,[null,10,20]);assert.deepEqual(r.series[1].counts,[2,1,1]);assert.ok(Math.abs(r.series[1].values[0]-5)<1e-12);
});
test('identifier, inclusive time tolerance and great-circle proximity use AND with explicit ambiguous matching rules',async()=>{
 const p=await project(a,'a',null,['asset','when']);const q=await project(b,'b',null,['station','observed']);
 const base={id:'r',name:'Assets',leftSource:'a',rightSource:'b',identifier:{left:'asset',right:'station'},time:{left:'when',right:'observed',toleranceMs:45000},spatial:{radiusMetres:50},match:'all'};
 const all=await relate(base,p,q);assert.deepEqual(all.pairs,[[0,0],[0,1]]);assert.equal(all.matchedLeft,1);assert.equal(all.unmatchedLeft,3);assert.equal(all.unmatchedRight,3);assert.equal(all.multiplyLeft,1);
 assert.deepEqual((await relate({...base,match:'unique'},p,q)).pairs,[]);assert.deepEqual((await relate({...base,match:'nearest'},p,q)).pairs,[[0,0]]);
 assert.deepEqual((await relate({...base,identifier:undefined,spatial:undefined},p,q)).pairs,[[0,0],[0,1],[2,3]]);
 assert.ok(distanceMetres(179.999,0,-179.999,0)<230);
 await assert.rejects(relate({...base,identifier:undefined,time:undefined,spatial:undefined},p,q),/at least one/);
});
test('saved comparison configuration strips projections, links and previews and rejects row-index filters',()=>{
 const comparison={id:'c',name:'Compare',kind:'histogram',unit:'C',bins:24,bucketMs:3600000,aggregate:'count',series:[{...series('s','a','temp'),values:['RAW_SECRET']}],results:['RAW_SECRET']};const relationship={id:'r',name:'R',leftSource:'a',rightSource:'b',identifier:{left:'asset',right:'station'},match:'all',pairs:['RAW_SECRET'],preview:['RAW_SECRET']};
 const state=configurationState(emptyState().settings,emptyState().query,[],{comparisons:[comparison],relationships:[relationship]});assert.ok(!JSON.stringify(state).includes('RAW_SECRET'));assert.equal(state.comparisons[0].series[0].x,'temp');assert.deepEqual(state.relationships[0].identifier,relationship.identifier);
 assert.throws(()=>configurationState(emptyState().settings,emptyState().query,[],{comparisons:[{...comparison,series:[{...comparison.series[0],filter:{op:'row',index:1}}]}]}),/Individual-observation/);
});
