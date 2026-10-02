import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { queryFilter, timeBounds } from '../src/wfs-query.ts';
import { xmlDocument } from '../src/data.ts';
import { start } from '../server/server.ts';
import { feature } from '../server/demo.ts';
const time = { start: '2025-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' };
const bbox = { west: -5, south: 52, east: 0, north: 56 };
const fields = { time: 'timestamp', geometry: 'geometry' };
test('time/area filters use version-specific standard XML and independent geographic axis order', () => {
  assert.deepEqual(timeBounds(24, Date.parse('2026-10-02T12:00:00Z')), { start: '2026-10-01T12:00:00.000Z', end: '2026-10-02T12:00:00.000Z' });
  for (const version of ['2.0.0', '1.1.0', '1.0.0']) {
    const filter = queryFilter(version, { time, bbox }, fields);
    const parsed = xmlDocument(filter).Filter.And;
    assert.ok(parsed.PropertyIsGreaterThanOrEqualTo);
    assert.ok(parsed.PropertyIsLessThanOrEqualTo);
    assert.ok(parsed.BBOX);
    assert.match(filter, version === '2.0.0' ? /fes:ValueReference/ : /ogc:PropertyName/);
    assert.match(filter, version === '1.0.0' ? /<gml:coordinates>-5,52 0,56/ : /<gml:lowerCorner>-5 52/);
  }
  assert.equal(queryFilter('2.0.0', {}, fields), undefined);
  assert.ok(xmlDocument(queryFilter('2.0.0', { bbox }, fields)).Filter.BBOX);
  const escaped = queryFilter('2.0.0', { time }, { ...fields, time: 'd:when&<', namespaces: { d: 'urn:test&"', fes: 'bad' } });
  assert.equal(xmlDocument(escaped).Filter.And.PropertyIsGreaterThanOrEqualTo.ValueReference, 'd:when&<');
  assert.match(escaped, /xmlns:d="urn:test&amp;&quot;"/);
  assert.throws(() => queryFilter('2.0.0', { time }, { ...fields, time: '' }), /time attribute/);
  assert.throws(() => queryFilter('2.0.0', { bbox }, { ...fields, geometry: '' }), /geometry attribute/);
  assert.throws(() => queryFilter('2.0.0', { time: { start: time.end, end: time.start } }, fields), /before the end/);
  assert.throws(() => queryFilter('2.0.0', { bbox: { ...bbox, north: NaN } }, fields), /Invalid map area/);
});
test('fixture applies the same time/area predicate before hits and pagination in JSON and GML', async () => {
  const s = start(0); await once(s, 'listening');
  const base = `http://127.0.0.1:${s.address().port}/wfs`;
  const expected = Array.from({ length: 1024 }, (_, i) => feature(i)).filter(f => {
    const [x, y] = f.geometry.coordinates, t = Date.parse(f.properties.timestamp);
    return x >= bbox.west && x <= bbox.east && y >= bbox.south && y <= bbox.north && t >= Date.parse(time.start) && t <= Date.parse(time.end);
  });
  try {
    const get = args => fetch(base + '?' + new URLSearchParams({ version: '2.0.0', request: 'GetFeature', typeNames: 'demo:points', points: '1024', filter: queryFilter('2.0.0', { time, bbox }, fields), count: '7', ...args }));
    assert.match(await (await get({ resultType: 'hits' })).text(), new RegExp(`numberMatched="${expected.length}"`));
    const result = [];
    for (let offset = 0; offset < expected.length; offset += 7) {
      const page = await (await get({ startIndex: String(offset) })).json();
      assert.equal(page.numberMatched, expected.length);
      result.push(...page.features);
    }
    assert.deepEqual(result, expected);
    assert.ok(expected.length > 7 && expected.length < 1024);
    const gml = await (await get({ outputFormat: 'application/gml+xml; version=3.2', srsName: 'urn:ogc:def:crs:EPSG::4326' })).text();
    assert.match(gml, new RegExp(`gml:id="${expected[0].id}"`));
    const empty = await (await get({ filter: queryFilter('2.0.0', { time: { start: '2030-01-01T00:00:00Z', end: '2030-01-02T00:00:00Z' } }, fields) })).json();
    assert.equal(empty.numberMatched, 0); assert.deepEqual(empty.features, []);
    assert.equal((await get({ bbox: '-5,52,0,56' })).status, 400);
    assert.equal((await get({ filter: '<!DOCTYPE Filter><Filter/>' })).status, 400);
  } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
});
