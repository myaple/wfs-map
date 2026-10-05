import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { validateServerFilters, serverPredicate } from '../src/server-filters.ts';
import { queryFilter } from '../src/wfs-query.ts';
import { xmlDocument } from '../src/data.ts';
import { csvDataset, ingestCSV, describeCSV } from '../src/csv.ts';
import { defaultConfig, migrateSource } from '../src/source-settings.ts';
import { configurationState, localSettings } from '../src/analysis-state.ts';
import { createBackup, readBackup } from '../src/source-backup.ts';
import { start } from '../server/server.ts';
import { feature } from '../server/demo.ts';
import { fixtureFilter } from '../server/filter.ts';
const fields = [{name:'value',kind:'number'},{name:'category',kind:'string'},{name:'active',kind:'boolean'},{name:'timestamp',kind:'date'}];
const rule = (field,kind,op,value) => ({field,kind,op,...(value === undefined ? {} : {value})});
test('server filters validate field identity, kind, operator, value and bounded configuration', () => {
  validateServerFilters([rule('value','number','gte','2')], fields);
  for (const rules of [[rule('unknown','number','eq','2')],[rule('value','string','eq','2')],[rule('value','number','contains','2')],[rule('active','boolean','gt','true')],[rule('value','number','eq','NaN')],[rule('value','number','eq','')],[rule('timestamp','date','eq','bad')],[{...rule('category','string','eq','x'),rows:[]}],Array(101).fill(rule('value','number','null'))]) assert.throws(() => validateServerFilters(rules,fields));
});
test('typed server predicates implement AND, inclusive edges, UTC offsets, literal strings and nulls', () => {
  const p = {value:2,category:'A*?!<&',active:true,timestamp:'2026-01-01T01:00:00+01:00'};
  assert(serverPredicate([rule('value','number','gte','2'),rule('value','number','lte','2'),rule('active','boolean','eq','true'),rule('timestamp','date','eq','2026-01-01 00:00:00'),rule('category','string','contains','*?!<')], fields)(p));
  for (const op of ['eq','ne','gt','gte','lt','lte','contains']) {
    const kind=op==='contains'?'string':'number',field=op==='contains'?'category':'value';
    assert.equal(serverPredicate([rule(field,kind,op,'2')],fields)({}),false);
  }
  assert(serverPredicate([rule('value','number','null')],fields)({value:null}));
  assert(serverPredicate([rule('value','number','notnull')],fields)(p));
});
test('WFS attribute rules compose with time and geography and escape XML and LIKE literals across versions', () => {
  const rules=[rule('value','number','gt','1e1'),rule('category','string','contains','A*?!<&'),rule('active','boolean','ne','false'),rule('timestamp','date','gte','2026-01-01T01:00:00+01:00'),rule('category','string','null'),rule('value','number','notnull')];
  for(const version of ['1.0.0','1.1.0','2.0.0']) {
    const f=queryFilter(version,{time:{start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z'},bbox:{west:-5,south:50,east:2,north:60}},{time:'timestamp',geometry:'geometry',attributes:{value:'d:value'},namespaces:{d:'urn:demo'}},rules);
    const and=xmlDocument(f).Filter.And;
    assert.equal(and.PropertyIsGreaterThan[version==='2.0.0'?'ValueReference':'PropertyName'],'d:value');
    assert.equal(and.PropertyIsGreaterThan.Literal,'10');
    assert.equal(and.PropertyIsLike.Literal,'*A!*!?!!<&*');
    assert.equal(and.PropertyIsLike[version==='1.0.0'?'@_escape':'@_escapeChar'],'!');
    assert(and.Not.PropertyIsNull); assert(and.BBOX); assert.match(f,/2026-01-01T00:00:00.000Z/);
  }
});
const config={...defaultConfig,type:'csv',longitudeField:'lon',latitudeField:'lat',timeField:'timestamp',fieldTypes:'{"code":"string"}',csvText:'lon,lat,value,category,active,timestamp,code\n-1,54,1,A,true,2026-01-01T00:00:00Z,001\n-2,55,2,B,false,2026-01-01T01:00:00Z,002\n-3,56,3,A,true,2026-01-02T00:00:00Z,003\n-4,57,,A,true,2026-01-03T00:00:00Z,004'};
test('CSV advanced rules exclude rows during ingestion and preserve original rows, schema and reports',async()=>{
  const rules=[rule('value','number','gte','2'),rule('category','string','eq','A')];
  const sync=csvDataset(config,{},rules),features=[];let schema;
  const streamed=await ingestCSV(new Blob([config.csvText]),config,{},f=>schema=f,b=>features.push(...b),undefined,rules);
  assert.deepEqual(features,sync.features); assert.deepEqual(streamed.report,sync.report); assert.deepEqual(schema,await describeCSV(new Blob([config.csvText]),config));
  assert.equal(features.length,1);assert.equal(features[0].id,'csv.4');assert.equal(features[0].properties.code,'003');
  assert.deepEqual({imported:sync.report.imported,filtered:sync.report.filtered,rejected:sync.report.rejected},{imported:1,filtered:3,rejected:0});
  assert.equal(csvDataset(config,{},[rule('value','number','null')]).features[0].id,'csv.5');
  assert.equal(csvDataset(config,{},[rule('value','number','gt','99')]).features.length,0);
  assert.throws(()=>csvDataset(config,{},[rule('gone','string','eq','x')]),/missing/);
});
test('filtered streaming CSV starts with bounded map allocation and retains enough growth capacity',async()=>{
  const c={...config,csvText:'lon,lat,value,category,active,timestamp,code\n'+Array.from({length:30000},(_,i)=>`-1,54,${i},A,true,2026-01-01T00:00:00Z,${i}`).join('\n')};
  let capacity,limit,count=0;
  await ingestCSV(new Blob([c.csvText]),c,{},(f,size,max)=>{capacity=size;limit=max;},b=>count+=b.length,undefined,[rule('value','number','gt','29998')]);
  assert.equal(count,1);assert.equal(capacity,25000);assert.equal(limit,30000);
});
test('per-source server filters survive saved analyses, migration and backups',async()=>{
  globalThis.location=new URL('http://localhost');
  const rules=[rule('code','string','eq','001')],source={id:'csv',name:'CSV',enabled:true,config,serverFilters:rules};
  const settings={sources:[source,{...source,id:'other',serverFilters:[]}],background:{url:'',attribution:'',enabled:false}};
  const state=configurationState(settings,{choice:'all',bounds:{}},[]);
  assert.deepEqual(localSettings(state).sources[0].serverFilters,rules);assert.deepEqual(migrateSource(source).serverFilters,rules);
  const restored=await readBackup(await createBackup(settings,()=>{throw Error('inline CSV expected')}));
  assert.deepEqual(restored.sources[0].serverFilters,rules);assert.deepEqual(restored.sources[1].serverFilters,[]);
});
test('WFS fixture applies attributes before hits and every paged result; XML predicates agree across versions',async()=>{
 const rules=[rule('category','string','eq','sensor'),rule('value','number','gte','50'),rule('active','boolean','eq','true')];
 const expected=Array.from({length:512},(_,i)=>feature(i)).filter(f=>serverPredicate(rules,fields)(f.properties));
 const server=start(0);await once(server,'listening');
 for(const version of ['1.0.0','1.1.0','2.0.0']) assert.deepEqual(Array.from({length:512},(_,i)=>feature(i)).filter(fixtureFilter(queryFilter(version,{}, {time:'timestamp',geometry:'geometry'},rules))),expected);
 try { for(const version of ['2.0.0']) {
   const url=`http://127.0.0.1:${server.address().port}/wfs?`;
   const get=args=>fetch(url+new URLSearchParams({version,request:'GetFeature',points:'512',[version==='2.0.0'?'typeNames':'typeName']:'demo:points',filter:queryFilter(version,{}, {time:'timestamp',geometry:'geometry'},rules),[version==='2.0.0'?'count':'maxFeatures']:'7',...args}));
   if(version!=='1.0.0') assert.match(await(await get({resultType:'hits'})).text(),new RegExp(`numberMatched="${expected.length}"`));
   const result=[];for(let offset=0;offset<expected.length;offset+=7){const p=await(await get({startIndex:String(offset)})).json();result.push(...p.features);}
   assert.deepEqual(result,expected);
 } } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
