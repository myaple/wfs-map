import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePage, countFrom, inferFields, packPositions, spatialPage, wfsURL, mercator, MAX_MERCATOR_LATITUDE, latitudeClampWarning } from '../src/data.ts';
import { Store } from '../src/store.ts';
import { feature } from '../server/demo.ts';

test('column filters combine numbers, exact categories, booleans and time; IDs survive filtering',async()=>{
  const f=Array.from({length:1024},(_,i)=>feature(i));
  const store=new Store(inferFields(f));store.append(f.slice(0,500));store.append(f.slice(500));store.finish();
  const rules=[{field:'category',op:'eq',value:'sensor'},{field:'value',op:'gte',value:'30'},{field:'active',op:'eq',value:'true'},{field:'timestamp',op:'lt',value:'2026-01-01T00:00:00Z'}];
  const indices=await store.filter(rules);
  const expected=f.flatMap((p,i)=>p.properties.category==='sensor'&&p.properties.value>=30&&p.properties.active&&p.properties.timestamp<'2026-01-01T00:00:00Z'?[i]:[]);
  assert.deepEqual([...indices],expected);
  assert.equal(store.get(indices[0]).id,f[indices[0]].id);
  assert.equal(await store.filter([]),null);
});
test('null semantics, strings, invalid operands and superseded filter scans',async()=>{
  const f=[0,1,2].map(i=>({...feature(i),properties:{n:i===0?null:i,text:i===0?null:i===1?'north':'south'}}));
  const store=new Store(inferFields(f));store.append(f);
  assert.deepEqual([...(await store.filter([{field:'n',op:'null'}]))],[0]);
  assert.deepEqual([...(await store.filter([{field:'text',op:'contains',value:'ou'}]))],[2]);
  assert.deepEqual([...(await store.filter([{field:'text',op:'ne',value:'north'}]))],[2]);
  await assert.rejects(store.filter([{field:'n',op:'gte',value:'not a number'}]),/Invalid number/);
  await assert.rejects(store.filter([{field:'n',op:'gte',value:'0'}],()=>true),/Superseded/);
});
test('duplicate pagination fails loudly',()=>{
  const f=[feature(0),feature(1)],s=new Store(inferFields(f));s.append(f);
  assert.throws(()=>s.append(f),/Repeated feature ID/);
});
test('empty GML collections without count metadata complete normally',()=>{
  for(const text of ['<FeatureCollection/>','<wfs:FeatureCollection xmlns:wfs="urn:wfs"></wfs:FeatureCollection>']) {
    assert.deepEqual(decodePage(text),{features:[],numberMatched:undefined});
    assert.equal(countFrom(text),undefined);
  }
  assert.throws(()=>decodePage('<other/>'),/Expected a GML FeatureCollection/);
});
test('GML 3 Point parsing, axis order, nulls and exceptions',()=>{
  const text=`<wfs:FeatureCollection xmlns:wfs="urn:wfs" xmlns:gml="urn:gml" xmlns:d="urn:demo" xmlns:xsi="urn:xsi" numberMatched="1"><wfs:member><d:points gml:id="abc"><d:geom><gml:Point><gml:pos>54 -1.5</gml:pos></gml:Point></d:geom><d:value>4.2</d:value><d:missing xsi:nil="true"/></d:points></wfs:member></wfs:FeatureCollection>`;
  const page=decodePage(text,'yx');assert.equal(page.numberMatched,1);assert.deepEqual(page.features[0].geometry.coordinates,[-1.5,54]);assert.equal(page.features[0].properties.missing,null);
  assert.equal(countFrom(text),1);
  assert.throws(()=>decodePage('<ows:ExceptionReport xmlns:ows="x"><ows:ExceptionText>bad request</ows:ExceptionText></ows:ExceptionReport>'),/bad request/);
  assert.equal(countFrom('<FeatureCollection numberMatched="unknown"/>'),undefined);
});
test('split-float Mercator retains coordinate precision at zoom 22',()=>{
  const f=feature(42),p=packPositions([f]);const expected=mercator(...f.geometry.coordinates);
  assert.ok(Math.abs((p[0]+p[2])-expected[0])*512*2**22<.001);
  assert.ok(Math.abs((p[1]+p[3])-expected[1])*512*2**22<.001);
  assert.throws(()=>packPositions([{...f,geometry:{type:'Polygon',coordinates:[]}}]),/Point/);
  assert.throws(()=>mercator(200,54),/Coordinate/);
});
test('WFS URL preserves vendor parameters while replacing uppercase reserved arguments',()=>{
  const url=new URL(wfsURL('http://localhost/wfs?REQUEST=old&TOKEN=abc&points=100','2.0.0','GetFeature',{count:'10'}));
  assert.equal(url.searchParams.get('request'),'GetFeature');assert.equal(url.searchParams.has('REQUEST'),false);assert.equal(url.searchParams.get('TOKEN'),'abc');assert.equal(url.searchParams.get('points'),'100');
});
test('polar coordinates clamp only map positions and report affected points',()=>{
  const latitudes=[90,86,MAX_MERCATOR_LATITUDE,54,-MAX_MERCATOR_LATITUDE,-86,-90];
  const features=latitudes.map((lat,id)=>({id,geometry:{type:'Point',coordinates:[10,lat]},properties:{}}));
  let clamped=0;
  const positions=packPositions(features,count=>clamped+=count);
  assert.equal(clamped,4);
  assert.deepEqual(features.map(f=>f.geometry.coordinates[1]),latitudes);
  for(let i=0;i<latitudes.length;i++) {
    const y=positions[i*4+1]+positions[i*4+3];
    assert.ok(Number.isFinite(y)&&y>=0&&y<=1);
    if(latitudes[i]>=MAX_MERCATOR_LATITUDE) assert.equal(y,0);
    if(latitudes[i]<=-MAX_MERCATOR_LATITUDE) assert.equal(y,1);
  }
  assert.match(latitudeClampWarning(clamped),/4 points.*clamped.*Original coordinates/);
  assert.equal(latitudeClampWarning(0),'');
  for(const [lon,lat] of [[0,91],[0,-91],[181,0],[-181,0],[NaN,0],[0,Infinity]])
    assert.throws(()=>mercator(lon,lat),/Coordinate is invalid.*longitude.*latitude/);
});
test('spatial buckets cover every original feature index and contain all member positions',()=>{
  const positions=packPositions(Array.from({length:2048},(_,i)=>feature(i)));
  const {indices,groups}=spatialPage(positions,5000);
  assert.deepEqual([...indices].sort((a,b)=>a-b),Array.from({length:2048},(_,i)=>5000+i));
  let count=0;
  for(let g=0;g<groups.length;g+=6) {
    const [start,n,left,top,right,bottom]=groups.subarray(g,g+6);count+=n;
    for(let j=start-5000;j<start-5000+n;j++) {
      const i=indices[j]-5000,x=positions[i*4]+positions[i*4+2],y=positions[i*4+1]+positions[i*4+3];
      assert.ok(x>=left&&x<=right&&y>=top&&y<=bottom);
    }
  }
  assert.equal(count,2048);
});
