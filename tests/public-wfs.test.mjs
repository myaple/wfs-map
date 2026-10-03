import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodePage, inferFields, packPositions} from '../src/data.ts';
import {Store} from '../src/store.ts';
const read = name => readFileSync(new URL('./fixtures/public-wfs/'+name,import.meta.url),'utf8');
for(const city of ['hamburg','berlin']) test(`${city}: captured public GeoJSON and GML retain IDs, coordinates, nulls and metadata`,()=>{
 const json=decodePage(read(city+'-page.json')),gml=decodePage(read(city+'-page.gml'));
 assert.equal(json.features.length,2);assert.equal(gml.features.length,2);
 for(let i=0;i<2;i++) {
  const a=json.features[i],b=gml.features[i];
  assert.equal(a.id,b.id);assert.equal(a.geometry.type,'Point');assert.equal(b.geometry.type,'Point');
  // Separate requests serialize coordinates at different precision.
  for(let j=0;j<2;j++) assert.ok(Math.abs(a.geometry.coordinates[j]-b.geometry.coordinates[j])<1e-6);
  for(const [key,val] of Object.entries(a.properties)) {
   if(val===null) assert.ok(b.properties[key]==null);
   else if(typeof val==='number') assert.equal(Number(b.properties[key]),val);
   else assert.equal(String(b.properties[key]),String(val));
  }
 }
 assert.equal(packPositions(json.features).length,8);assert.equal(packPositions(gml.features).length,8);
 const store=new Store(inferFields(json.features));store.append(json.features);store.finish();assert.equal(store.get(0).id,json.features[0].id);
});
test('MultiPoint conversion never silently discards extra locations',()=>{
 for(const coordinates of [[], [[10,53],[11,54]]]) assert.throws(()=>decodePage(JSON.stringify({type:'FeatureCollection',features:[{geometry:{type:'MultiPoint',coordinates},properties:{}}]})),/single-point MultiPoint/);
 assert.throws(()=>decodePage('<FeatureCollection><member><tree><geom><MultiPoint><pointMember><Point><pos>10 53</pos></Point></pointMember><pointMember><Point><pos>11 54</pos></Point></pointMember></MultiPoint></geom></tree></member></FeatureCollection>'),/single-point GML MultiPoint/);
});
for(const version of ['1.1.0','1.0.0'])test(`Berlin ${version}: returned GML page count is not the total and original IDs survive`,()=>{
 const page=decodePage(read('berlin-'+version+'.gml'));
 assert.equal(page.features.length,2);assert.equal(page.numberMatched,undefined);
 assert.deepEqual(page.features.map(f=>f.id),['strassenbaeume.00008100_0010f3d2','strassenbaeume.00008100_00109d0e']);
 assert.deepEqual(page.features.map(f=>f.geometry.coordinates),[[13.30321023,52.58916448],[13.29758565,52.58189811]]);
 assert.equal(packPositions(page.features).length,8);
});
