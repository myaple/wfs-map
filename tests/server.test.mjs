import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { start } from '../server/server.ts';
import { decodePage } from '../src/data.ts';
test('development WFS discovery, hits, capped paging, gzip, GML and validation',async()=>{
  const s=start(0);await once(s,'listening');const base=`http://127.0.0.1:${s.address().port}/wfs`;
  const get=async p=>fetch(base+'?'+new URLSearchParams({service:'WFS',version:'2.0.0',typeNames:'demo:points',points:'105',...p}));
  try {
    assert.match(await (await get({request:'GetCapabilities'})).text(),/ImplementsResultPaging/);
    assert.match(await (await get({request:'DescribeFeatureType'})).text(),/dateTime/);
    assert.match(await (await get({request:'GetFeature',resultType:'hits'})).text(),/numberMatched="105"/);
    const a=await get({request:'GetFeature',count:'100',outputFormat:'application/json'});assert.equal(a.headers.get('content-encoding'),'gzip');const pa=await a.json();assert.equal(pa.features.length,100);
    const pb=await (await get({request:'GetFeature',startIndex:'100',count:'100',outputFormat:'application/json'})).json();assert.equal(pb.features.length,5);assert.equal(pb.features[0].id,'points.100');
    const gml=await (await get({request:'GetFeature',count:'1',outputFormat:'application/gml+xml; version=3.2',srsName:'urn:ogc:def:crs:EPSG::4326'})).text();
    assert.deepEqual(decodePage(gml,'yx').features[0].geometry.coordinates,pa.features[0].geometry.coordinates);
    assert.equal((await get({request:'GetFeature',count:'-1'})).status,400);
    assert.equal((await get({request:'GetFeature',filter:'unsupported'})).status,400);
  }finally{s.closeAllConnections();await new Promise(r=>s.close(r));}
});

test('test WFS starts on demand, exposes a normal endpoint, and lifecycle is scoped to its host server', async () => {
  const s = start(0); await once(s, 'listening'); const base = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await (await fetch(base + '/api/test-wfs')).json()).running, false);
    assert.equal((await fetch(base + '/test-wfs')).status, 503);
    assert.equal((await fetch(base + '/api/test-wfs/start')).status, 405);
    assert.equal((await fetch(base + '/api/test-wfs/start', { method: 'POST' })).status, 415);
    assert.equal((await fetch(base + '/api/test-wfs/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' })).status, 403);
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await fetch(base + '/api/test-wfs/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(), { running: true, endpoint: '/test-wfs' });
    assert.match(await (await fetch(base + '/test-wfs?request=GetCapabilities')).text(), /\/test-wfs/);
    const response = await fetch(base + '/test-wfs?request=GetFeature&typeNames=demo:points&points=12&distribution=dense&count=5');
    const page = await response.json(); assert.equal(page.numberMatched, 12); assert.equal(page.features.length, 5);
    assert.ok(page.features.every(f => f.geometry.coordinates[0] >= -1.55 && f.geometry.coordinates[0] <= -1.53));
  } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
});
