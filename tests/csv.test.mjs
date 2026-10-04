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

test('CSV review preserves IDs, casts explicitly, counts missing tokens and quarantines every invalid record', async () => {
    const { previewCSV } = await import('../src/csv.ts');
    const text = '\uFEFFlon,lat,id,value,active,when\r\n-1,54,000123,2,TRUE,2026-10-01 12:30\r\n-2,53,000124,N/A,false,2026-10-01T14:30+02:00\r\n-3,52,000125,bad,yes,2026-02-30\r\n-4,95,000126,4,true,2026-10-02\r\n-5,51,000127,,false,\r\n';
    const c = config(text, { timeField: 'when', csvTypes: JSON.stringify({ id: 'string', value: 'number', active: 'boolean' }), csvInvalidRows: 'quarantine' });
    const preview = previewCSV(c), loaded = csvDataset(c);
    assert.deepEqual([preview.total, preview.accepted, preview.rejected], [5, 3, 2]);
    assert.deepEqual([loaded.accepted, loaded.rejected], [3, 2]);
    assert.deepEqual(loaded.features.map(f => f.id), ['csv.2', 'csv.3', 'csv.6']);
    assert.deepEqual(loaded.features.map(f => f.properties.id), ['000123', '000124', '000127']);
    assert.equal(preview.inferred.find(f => f.name === 'id').kind, 'string');
    assert.equal(preview.missing[3], 2); assert.equal(preview.failed[3], 1);
    assert.equal(preview.failed[4], 1); assert.equal(preview.failed[5], 1);
    assert.equal(loaded.features[1].properties.value, null);
    assert.equal(loaded.features[0].properties.when, loaded.features[1].properties.when);
    assert.equal(c.csvText, text);
    const diagnostics = parseCSV(await preview.diagnostics.text());
    assert.equal(diagnostics.rows.length, 4); // all three casts in record 4 plus record 5's geometry
    assert.deepEqual([...new Set(diagnostics.rows.map(r => r[0]))], ['4', '5']);
    assert.ok(diagnostics.rows.every(r => JSON.parse(r[4]).length === 6));
    assert.throws(() => csvDataset({ ...c, csvInvalidRows: 'reject' }), /CSV row 4/);
    const store = new Store(loaded.fields); store.append(loaded.features); store.finish();
    const { exportCSV } = await import('../src/csv-export.ts');
    const exported = parseCSV(await (await exportCSV(store, null)).text());
    assert.deepEqual(exported.rows.map(r => r[5]), ['000123', '000124', '000127']);
    assert.deepEqual(csvDataset(structuredClone(c)), loaded);
});
test('CSV missing tokens support numeric inference; explicit casts do not silently coerce values', async () => {
    const { previewCSV } = await import('../src/csv.ts');
    const c = config('lon,lat,id,value\n-1,54,000123,2\n-2,53,000124,N/A\n-3,52,000125,');
    assert.equal(csvDataset(c).fields.find(f => f.name === 'value').kind, 'number');
    assert.equal(csvDataset(c).features[0].properties.id, '000123');
    assert.equal(csvDataset({ ...c, csvTypes: '{"id":"number"}' }).features[0].properties.id, 123);
    assert.equal(csvDataset({ ...c, csvMissingValues: '[""]' }).fields.find(f => f.name === 'value').kind, 'string');
    const custom = config('lon,lat,value\n-1,54,  missing  \n-2,53,Missing\n-3,52,0x10\n-4,51,Infinity', { csvTypes: '{"value":"number"}', csvMissingValues: '["missing"]', csvInvalidRows: 'quarantine' });
    const preview = previewCSV(custom);
    assert.equal(preview.missing[2], 1); assert.equal(preview.failed[2], 3);
    assert.deepEqual(csvDataset(custom).features.map(f => f.properties.value), [null]);
    assert.throws(() => csvDataset({ ...c, csvTypes: '{"id":"string"}', timeField: 'id' }), /date\/time type/);
    for (const overrides of ['[]', '{"id":"wat"}', '{"id":{}}']) assert.throws(() => csvDataset({ ...c, csvTypes: overrides }));
});
test('quarantine handles wrong-width and empty records, preserves logical record IDs and reserves malformed quoting', async () => {
    const { previewCSV } = await import('../src/csv.ts');
    const c = config('lon,lat,label\n-1,54,"line 1\nline 2"\n\n-2,53\n,,\n-3,52,last', { csvInvalidRows: 'quarantine' });
    const preview = previewCSV(c), loaded = csvDataset(c);
    assert.deepEqual([preview.accepted, preview.rejected], [2, 2]);
    assert.deepEqual(loaded.features.map(f => f.id), ['csv.2', 'csv.6']);
    assert.deepEqual(parseCSV(await preview.diagnostics.text()).rows.map(r => r[0]), ['4', '5']);
    assert.throws(() => previewCSV(config('lon,lat\n"bad,54', { csvInvalidRows: 'quarantine' })), /unterminated/);
    assert.equal(csvDataset(config('lon,lat,constructor,__proto__\n-1,54,label,001')).features[0].properties.constructor, 'label');
});
