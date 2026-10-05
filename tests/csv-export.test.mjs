import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCSV, csvExportFilename } from '../src/csv-export.ts';
import { parseCSV } from '../src/csv.ts';
import { Store } from '../src/store.ts';

test('CSV export round-trips every attribute, precision, quoting and nulls across chunks', async () => {
    const store = new Store([
        { name: 'longitude', kind: 'string' }, { name: 'featureId', kind: 'number' },
        { name: 'notes,"quoted"', kind: 'string' }, { name: 'when', kind: 'date' }, { name: 'active', kind: 'boolean' },
    ]);
    const feature = (id, active) => ({ id, geometry: { type: 'Point', coordinates: [-1.1234567890123, 54.1234567890123] },
        properties: { longitude: '東京, café', featureId: 42, 'notes,"quoted"': 'first\r\nsecond "quote"', when: '2026-10-01T12:34:56.789Z', active } });
    store.append([feature('first', true), feature('second', false)]);
    store.append([feature('third', null)]); store.finish();
    const { headers, rows } = parseCSV(await (await exportCSV(store, null)).text());
    assert.deepEqual(headers, ['featureId_2', 'longitude_2', 'latitude', ...store.fields.map(f => f.name)]);
    assert.deepEqual(rows[0], ['first', '-1.1234567890123', '54.1234567890123', '東京, café', '42', 'first\r\nsecond "quote"', '2026-10-01T12:34:56.789Z', 'true']);
    assert.equal(rows[1].at(-1), 'false'); assert.equal(rows[2].at(-1), '');
    assert.deepEqual(parseCSV(await (await exportCSV(store, new Uint32Array([1, 2]))).text()).rows, rows.slice(1));
    assert.deepEqual(parseCSV(await (await exportCSV(store, new Uint32Array())).text()), { headers, rows: [], rowLines: [], totalRows: 0, issues: [] });
});

test('CSV export supports geometry-only data, batches large selections and cancels stale work', async () => {
    const store = new Store([]);
    store.append(Array.from({ length: 10001 }, (_, id) => ({ id, geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} })));
    const csv = parseCSV(await (await exportCSV(store, null)).text());
    assert.equal(csv.rows.length, 10001); assert.deepEqual(csv.rows.at(-1), ['10000', '0', '0']);
    await assert.rejects(exportCSV(store, null, () => true), /cancelled/);
    assert.equal(csvExportFilename(' ../My source / test '), 'My-source-test-filtered.csv');
    assert.equal(csvExportFilename('...'), 'data-source-filtered.csv');
});
