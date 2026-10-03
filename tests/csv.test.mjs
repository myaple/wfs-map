import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csvDataset } from '../src/csv.ts';
import { defaultConfig } from '../src/source-settings.ts';
import { Store } from '../src/store.ts';
const config = (csvText, extra = {}) => ({ ...defaultConfig, type: 'csv', csvText, longitudeField: 'lon', latitudeField: 'lat', ...extra });
test('CSV quoting, multiline fields, CRLF, BOM and alternate delimiters', () => {
    assert.deepEqual(parseCSV('\uFEFFname,notes\r\n"a,b","first\nsecond ""quote"""\r\n').rows, [['a,b', 'first\nsecond "quote"']]);
    assert.deepEqual(parseCSV('x;y\n1;2', ';').rows, [['1', '2']]);
    assert.deepEqual(parseCSV('x\ty\n1\t2', '\t').rows, [['1', '2']]);
    for (const text of ['a,a\n1,2', 'a,\n1,2', 'a,b\n1', 'a\n"unterminated', 'a\n"ok"extra']) assert.throws(() => parseCSV(text));
});
test('CSV columns use whole-file types and configured time, preserve nulls and metadata', async () => {
    const dataset = csvDataset(config('lon,lat,when,value,mixed,active\n-1,54,2026-10-01,2,1,true\n-2,53,2026-10-02,,text,false', { timeField: 'when' }));
    assert.equal(dataset.fields.find(f => f.name === 'when').kind, 'date');
    assert.equal(dataset.fields.find(f => f.name === 'mixed').kind, 'string');
    const store = new Store(dataset.fields); store.append(dataset.features); store.finish();
    assert.equal(store.get(1).properties.value, null);
    assert.equal(store.get(0).properties.active, true);
    assert.equal(store.get(0).properties.when, '2026-10-01T00:00:00.000Z');
    assert.deepEqual([...(await store.filter([{ field: 'value', op: 'gte', value: '2' }]))], [0]);
});
test('CSV applies inclusive time and map bounds and retains original row IDs', () => {
    const c = config('lon,lat,t\n-1,54,2026-10-01\n-2,53,2026-10-02\n-3,52,2026-10-03', { timeField: 't' });
    const dataset = csvDataset(c, { time: { start: '2026-10-02T00:00:00Z', end: '2026-10-03T00:00:00Z' }, bbox: { west: -2, east: -1, south: 53, north: 54 } });
    assert.deepEqual(dataset.features.map(f => f.id), ['csv.3']);
    assert.throws(() => csvDataset(config('lon,lat\n-1,54'), { time: { start: '2026-10-02', end: '2026-10-03' } }), /time attribute/);
});
test('CSV Point geometry formats and invalid rows fail with row context', () => {
    for (const [geometryMode, csvText] of [['wkt', 'geom\nPOINT (-1 54)'], ['geojson', 'geom\n"{""type"":""Point"",""coordinates"":[-1,54]}"']]) {
        assert.deepEqual(csvDataset(config(csvText, { geometryMode, geometryField: 'geom' })).features[0].geometry.coordinates, [-1, 54]);
    }
    for (const csvText of ['lon,lat\n,54', 'lon,lat\n-1,90', 'lon,lat\ninvalid,54']) assert.throws(() => csvDataset(config(csvText)), /CSV row 2/);
    assert.throws(() => csvDataset(config('lon,lat,t\n-1,54,bad', { timeField: 't' })), /row 2.*Invalid ISO/);
    assert.throws(() => csvDataset(config('geom\nLINESTRING (0 0, 1 1)', { geometryMode: 'wkt', geometryField: 'geom' })));
});
