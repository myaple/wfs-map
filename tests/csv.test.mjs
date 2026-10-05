import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csvDataset, csvImportSummary, CSVParser, csvHeaders, streamCSV, ingestCSV } from '../src/csv.ts';
import { defaultConfig } from '../src/source-settings.ts';
import { Store } from '../src/store.ts';
import { packPositions } from '../src/data.ts';
import { exportCSV } from '../src/csv-export.ts';
const config = (csvText, extra = {}) => ({ ...defaultConfig, type: 'csv', csvText, longitudeField: 'lon', latitudeField: 'lat', ...extra });
test('CSV polar points retain original coordinates in records, filters and exports', async () => {
    const dataset = csvDataset(config('lon,lat,t\n10,90,2026-10-01\n20,-90,2026-10-02\n30,54,2026-10-03', { timeField: 't' }));
    const positions = packPositions(dataset.features);
    assert.equal(positions[1], 0); assert.equal(positions[5], 1);
    const store = new Store(dataset.fields); store.append(dataset.features); store.finish();
    assert.deepEqual(store.get(0).coordinates, [10,90]);
    assert.deepEqual(store.get(1).coordinates, [20,-90]);
    assert.deepEqual([...(await store.filter([{ field: 'lat', op: 'gt', value: '85' }]))], [0]);
    const exported = parseCSV(await (await exportCSV(store, null)).text());
    assert.equal(exported.rows[0][2], '90'); assert.equal(exported.rows[1][2], '-90');
    const bounded = csvDataset(config('lon,lat\n10,90\n20,54'), { bbox: { west: 0, east: 30, south: 50, north: 85 } });
    assert.deepEqual(bounded.features.map(f=>f.id), ['csv.3']);
    for (const [geometryMode, csvText] of [['wkt','geom\nPOINT (10 90)'], ['geojson','geom\n"{""type"":""Point"",""coordinates"":[10,-90]}"']])
        assert.equal(Math.abs(csvDataset(config(csvText, { geometryMode, geometryField: 'geom' })).features[0].geometry.coordinates[1]),90);
});
test('CSV quoting, multiline fields, CRLF, BOM and alternate delimiters', () => {
    assert.deepEqual(parseCSV('\uFEFFname,notes\r\n"a,b","first\nsecond ""quote"""\r\n').rows, [['a,b', 'first\nsecond "quote"']]);
    assert.deepEqual(parseCSV('x;y\n1;2', ';').rows, [['1', '2']]);
    assert.deepEqual(parseCSV('x\ty\n1\t2', '\t').rows, [['1', '2']]);
    for (const text of ['a,a\n1,2', 'a,\n1,2', 'a\n"unterminated']) assert.throws(() => parseCSV(text));
    for (const text of ['a,b\n1', 'a\n"ok"extra']) assert.equal(parseCSV(text).issues[0].count, 1);
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
test('CSV Point geometry formats and invalid rows fail with line context', () => {
    for (const [geometryMode, csvText] of [['wkt', 'geom\nPOINT (-1 54)'], ['geojson', 'geom\n"{""type"":""Point"",""coordinates"":[-1,54]}"']]) {
        assert.deepEqual(csvDataset(config(csvText, { geometryMode, geometryField: 'geom' })).features[0].geometry.coordinates, [-1, 54]);
    }
    for (const csvText of ['lon,lat\n,54', 'lon,lat\n-1,91', 'lon,lat\ninvalid,54']) assert.throws(() => csvDataset(config(csvText)), /CSV line 2/);
    assert.throws(() => csvDataset(config('lon,lat,t\n-1,54,bad', { timeField: 't' })), /Invalid ISO.*CSV line 2/);
    assert.throws(() => csvDataset(config('geom\nLINESTRING (0 0, 1 1)', { geometryMode: 'wkt', geometryField: 'geom' })));
});

test('CSV imports valid rows and counts every rejected record by reason and physical line', () => {
    const c = config('lon,lat,t,note\r\n-1,54,2026-10-01,"first\r\nsecond"\r\n\r\n,54,2026-10-01,missing\r\n-1,,2026-10-01,missing\r\n-1,54,bad,time\r\n-1,54\r\n-1,54,2026-10-01,"ok"extra\r\n-2,53,2026-10-02,\r\n,,,\r\n', { timeField: 't' });
    const { features, report } = csvDataset(c);
    assert.deepEqual(features.map(f => f.id), ['csv.2', 'csv.10']);
    assert.equal(features[1].properties.note, null);
    assert.deepEqual([report.total, report.imported, report.rejected, report.filtered], [8, 2, 6, 0]);
    assert.deepEqual(report.issues.find(i => i.reason.includes('Missing longitude')).lines, [5, 11]);
    assert.equal(report.issues.find(i => i.reason.includes('Missing longitude')).count, 2);
    assert.match(csvImportSummary(report), /2 of 8.*6 rows not processed/);
});
test('CSV blank times and undefined bounds are safe; bounds exclusions are distinct from errors', () => {
    const c = config('lon,lat,t,empty\n-1,54,,\n-1,54,2026-10-01,\n-1,54,2026-10-02,\n-3,52,2026-10-02,', { timeField: 't' });
    for (const bounds of [undefined, null]) {
        const { features, report } = csvDataset(c, bounds);
        assert.equal(features.length, 4); assert.equal(features[0].properties.t, null);
        assert.deepEqual([report.rejected, report.filtered], [0, 0]);
    }
    const { report, features } = csvDataset(c, { time: { start: '2026-10-02', end: '2026-10-03' }, bbox: { west: -2, east: 0, south: 53, north: 55 } });
    assert.deepEqual(features.map(f => f.id), ['csv.4']);
    assert.deepEqual([report.total, report.imported, report.rejected, report.filtered], [4, 1, 1, 2]);
    assert.match(report.issues[0].reason, /Missing time/);
    assert.throws(() => csvDataset(c, { time: { start: '', end: '' } }), /valid UTC/);
});
test('CSV null geometry, non-decimal coordinates, missing mappings and header-only data are handled', () => {
    for (const v of ['null', '', '{}', '[]', '"broken"']) {
        const text = 'geom\n' + '"' + v.replaceAll('"', '""') + '"';
        assert.throws(() => csvDataset(config(text, { geometryMode: 'geojson', geometryField: 'geom' })), /GeoJSON.*CSV line 2/);
    }
    for (const coordinate of ['0x10', 'Infinity', 'NaN', 'true']) assert.throws(() => csvDataset(config(`lon,lat\n${coordinate},54`)), /decimal numbers/);
    assert.throws(() => csvDataset(undefined), /settings are missing/);
    assert.throws(() => csvDataset(config('lon,lat\n-1,54', { longitudeField: undefined })), /1 data rows not processed: choose a CSV longitude/);
    assert.deepEqual(csvDataset(config('lon,lat')).report, { total: 0, imported: 0, rejected: 0, filtered: 0, issues: [] });
});
test('CSV failure reports all rejected rows and bounded examples; broken quoting never claims success', () => {
    const text = 'lon,lat\n' + ',54\n'.repeat(100);
    assert.throws(() => csvDataset(config(text)), /0 of 100.*100 rows not processed[\s\S]*CSV lines 2, 3, 4, 5, 6, …/);
    assert.throws(() => parseCSV('lon,lat\n-1,54\n"unfinished'), /No rows imported; 1 complete data rows/);
    const parsed = parseCSV('a,b\n"bad"extra,"multiple\nlines"\nvalid,record');
    assert.equal(parsed.totalRows, 2); assert.deepEqual(parsed.rows, [['valid', 'record']]);
    assert.deepEqual(parsed.rowLines, [4]); assert.equal(parsed.issues[0].count, 1);
});

test('incremental CSV handles every character boundary including quotes, multiline CRLF, BOM and UTF-8', async () => {
    const text = '\uFEFFlon,lat,t,note\r\n-1,54,2026-10-01,"東京, café\r\nsecond ""quote"""\r\n-2,53,,\r\n,54,,bad\r\n-1,54\r\n';
    const expected = parseCSV(text);
    for (const width of [1, 2, 3, 7, 64, 1000]) {
        const rows = [], rowLines = [];
        const parser = new CSVParser(',', (row, line) => { rows.push(row); rowLines.push(line); });
        for (let i = 0; i < text.length; i += width) parser.feed(text.slice(i, i + width));
        const { headers, totalRows, issues } = parser.finish();
        assert.deepEqual({ headers, rows, rowLines, totalRows, issues }, expected);
        const streamed = [], lines = [];
        const metadata = await streamCSV(new Blob([text]), ',', (row, line) => { streamed.push(row); lines.push(line); }, undefined, width);
        assert.deepEqual(streamed, expected.rows); assert.deepEqual(lines, expected.rowLines);
        assert.deepEqual(metadata.issues, expected.issues);
    }
    assert.deepEqual(await csvHeaders(new Blob([text])), expected.headers);
    assert.deepEqual(await csvHeaders(new Blob(['"a\nb",c\n"unterminated body'])), ['a\nb', 'c']);
});
test('streamed ingestion exactly matches synchronous typing, nulls, bounds, IDs and rejection reports', async () => {
    const c = config('lon,lat,t,mixed,boolean\n-1,54,2026-10-01,1,true\n-2,53,,text, false \n,54,bad,2,true\n-2,53,bad,2,true\n-1,54\n-3,52,2026-10-03,3,true', { timeField: 't' });
    for (const bounds of [{}, { time: { start: '2026-10-01', end: '2026-10-02' } }]) {
        const expected = csvDataset(c, bounds), features = []; let fields;
        const result = await ingestCSV(new Blob([c.csvText]), c, bounds, f => fields = f, batch => features.push(...batch));
        assert.deepEqual({ fields, features, report: result.report }, expected);
    }
    await assert.rejects(ingestCSV(new Blob(['lon,lat\n,54']), c, {}, () => {}, () => {}), /column "t" was not found/);
});
test('streamed ingestion has bounded feature batches and checks whole-file types beyond the first batch', async () => {
    const c = config('lon,lat,value\n' + '-1,54,1\n'.repeat(50001) + '-1,54,text');
    const sizes = []; let fields;
    const { report } = await ingestCSV(new Blob([c.csvText]), c, {}, f => fields = f, batch => sizes.push(batch.length));
    assert.deepEqual(sizes, [25000, 25000, 2]);
    assert.equal(fields.find(f => f.name === 'value').kind, 'string');
    assert.equal(report.imported, 50002);
});

test('CSV overrides preserve numeric categories and reject invalid explicit types in both ingestion paths', async () => {
    const c = config('lon,lat,code,value,flag,when\n-1,54,001,2,true,2026-10-01\n-1,54,002,oops,false,2026-10-02\n-1,54,003,3,yes,2026-10-03\n-1,54,,,,', { fieldTypes: JSON.stringify({ code: 'string', value: 'number', flag: 'boolean', when: 'date' }) });
    const expected = csvDataset(c);
    assert.equal(expected.fields.find(f => f.name === 'code').kind, 'string');
    assert.equal(expected.features[0].properties.code, '001');
    assert.equal(expected.features[0].properties.when, '2026-10-01T00:00:00.000Z');
    assert.equal(expected.features[1].properties.code, null);
    assert.deepEqual(expected.report.issues.map(i => i.reason), ['Invalid number in "value"', 'Expected true or false in "flag"']);
    const features = []; let fields;
    const { report } = await ingestCSV(new Blob([c.csvText]), c, {}, f => fields = f, batch => features.push(...batch));
    assert.deepEqual({ fields, features, report }, expected);
    const store = new Store(fields); store.append(features); store.finish();
    assert.deepEqual([...(await store.filter([{ field: 'code', op: 'eq', value: '001' }]))], [0]);
    assert.throws(() => csvDataset({ ...c, fieldTypes: '{' }), /Invalid CSV/);
    assert.throws(() => csvDataset({ ...c, fieldTypes: '{"absent":"string"}' }), /was not found/);
    assert.throws(() => csvDataset({ ...c, timeField: 'when', fieldTypes: '{"when":"string"}' }), /time attribute must/);
});
