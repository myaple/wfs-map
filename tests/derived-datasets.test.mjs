import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { joinDatasets, joinSnapshot } from '../src/derived-datasets.ts';
import { csvDataset, parseCSV } from '../src/csv.ts';
const fields = [{ name: 'key', kind: 'string' }, { name: 'value', kind: 'number' }, { name: 'day', kind: 'date' }, { name: 'flag', kind: 'boolean' }];
function store(rows, schema = fields) {
 const s = new Store(schema);
 s.append(rows.map((p, i) => ({ id: `row${i}`, geometry: { type: 'Point', coordinates: [-1.123456789, 89] }, properties: Object.fromEntries(schema.map((f, j) => [f.name, p[j] ?? null])) })));
 s.finish(); return s;
}
const a = store([['001', 1, '2025-01-02T00:00:00Z', true], ['x', 2, null, false], [null, 3], ['001', 4]]);
const b = store([['001', 10], ['001', 20], ['y', 30], [null, 40], ['x', 50]]);
const options = { leftField: 'key', rightField: 'key', mode: 'inner', scope: 'loaded', maxRows: 1000 };
const snapshots = () => [structuredClone(joinSnapshot(a, new Uint32Array([0, 1]))), structuredClone(joinSnapshot(b, new Uint32Array([1, 4])))];
test('exact joins preserve every duplicate pair, typed fields, nulls, UTC times and CSV escaping', async () => {
 const before = JSON.stringify([a.get(0), b.get(0)]);
 const result = await joinDatasets(...snapshots(), options, 'day', true);
 assert.deepEqual(result.report, { leftRows: 4, rightRows: 5, matchedLeft: 3, unmatchedLeft: 1, missingLeft: 1, missingRight: 1, duplicateRightKeys: 1, outputRows: 5 });
 const parsed = parseCSV(await result.blob.text()); assert.equal(new Set(parsed.headers).size, parsed.headers.length);
 assert.equal(result.config.timeField, 'left.day');
 const decoded = csvDataset({ ...result.config, csvText: await result.blob.text() }, {});
 assert.equal(decoded.features.length, 5);
 assert.deepEqual(decoded.features.map(f => f.properties['right.value']), [10, 20, 50, 10, 20]);
 assert.equal(decoded.features[0].properties['left.key'], '001');
 assert.equal(decoded.features[0].properties['left.day'], '2025-01-02T00:00:00.000Z');
 assert.equal(decoded.features[2].properties['left.flag'], false);
 assert.deepEqual(decoded.features[0].geometry.coordinates, [-1.123456789, 89]);
 assert.equal(before, JSON.stringify([a.get(0), b.get(0)]));
 const quoted = store([['comma,quote"\nline', 8]]);
 const escaped = await joinDatasets(joinSnapshot(quoted, null), joinSnapshot(quoted, null), options, '', true);
 assert.equal(csvDataset({ ...escaped.config, csvText: await escaped.blob.text() }, {}).features[0].properties['left.key'], 'comma,quote"\nline');
});
test('left joins retain unmatched rows with null right values; missing keys never join', async () => {
 const result = await joinDatasets(...snapshots(), { ...options, mode: 'left' }, '', true);
 assert.equal(result.report.outputRows, 6);
 const decoded = csvDataset({ ...result.config, csvText: await result.blob.text() }, {});
 assert.equal(decoded.features[3].properties['left.key'], null);
 assert.equal(decoded.features[3].properties['right.value'], null);
 assert.equal(decoded.features[3].properties['right.@id'], null);
 const blank = store([['', 1], [' ', 2], ['A', 3], ['a', 4]]);
 const result2 = await joinDatasets(joinSnapshot(blank, null), joinSnapshot(store([['A', 5], [null, 6], ['', 7]]), null), options);
 assert.equal(result2.report.outputRows, 1); assert.equal(result2.report.missingLeft, 2);
});
test('optional applied scope intersects each input independently; empty selections remain empty', async () => {
 const result = await joinDatasets(...snapshots(), { ...options, scope: 'applied' });
 assert.equal(result.report.outputRows, 2); assert.equal(result.report.leftRows, 2); assert.equal(result.report.rightRows, 2);
 const empty = await joinDatasets(joinSnapshot(a, new Uint32Array()), joinSnapshot(b, null), { ...options, scope: 'applied' });
 assert.equal(empty.report.outputRows, 0); assert.equal(empty.report.leftRows, 0);
});
test('an automatically discovered or namespace-qualified left time field remains configured in the copy', async () => {
 const automatic = await joinDatasets(...snapshots(), options);
 assert.equal(automatic.config.timeField, 'left.day');
 const qualified = await joinDatasets(...snapshots(), options, 'demo:day');
 assert.equal(qualified.config.timeField, 'left.day');
 const excluded = await joinDatasets(...snapshots(), { ...options, leftColumns: ['key'] });
 assert.equal(excluded.config.timeField, '');
});
test('columns can be excluded, including join keys; duplicate names and reserved-looking names cannot collide', async () => {
 const special = store([['a', 'payload', 5]], [{name: 'key', kind: 'string'}, {name: '@id', kind: 'string'}, {name: '@longitude', kind: 'number'}]);
 const result = await joinDatasets(joinSnapshot(special, null), joinSnapshot(special, null), { ...options, leftColumns: ['@id', '@longitude'], rightColumns: ['@id'] }, '', true);
 const names = result.fields.map(f => f.name); assert.equal(new Set(names).size, names.length);
 assert(!names.includes('left.key')); assert(!names.includes('right.key')); assert(!names.includes('right.@longitude_2'));
 const decoded = csvDataset({ ...result.config, csvText: await result.blob.text() }, {});
 assert.equal(decoded.features[0].properties['left.@id'], 'payload');
 assert.equal(decoded.features[0].properties['left.@id_2'], 'row0');
 assert.equal(decoded.features[0].properties['right.@id'], 'payload');
 assert.deepEqual(decoded.features[0].geometry.coordinates, [-1.123456789, 89]);
 const noFields = await joinDatasets(...snapshots(), { ...options, leftColumns: [], rightColumns: [] }, 'day', true);
 assert.equal(noFields.config.timeField, ''); assert.equal(noFields.fields.length, 6);
 const minimal = await joinDatasets(...snapshots(), { ...options, leftColumns: [], rightColumns: [], leftId: false, rightId: false, rightCoordinates: false }, '', true);
 assert.equal(minimal.fields.length, 2);
 assert.deepEqual(csvDataset({ ...minimal.config, csvText: await minimal.blob.text() }, {}).features[0].geometry.coordinates, [-1.123456789, 89]);
 await assert.rejects(joinDatasets(...snapshots(), { ...options, leftColumns: ['missing'] }), /no longer available/);
});
test('validation and cancellation bound materialization without truncating previews', async () => {
 const numeric = store([[1]], [{name:'key', kind:'number'}]);
 await assert.rejects(joinDatasets(joinSnapshot(a, null), joinSnapshot(numeric, null), options), /same type/);
 await assert.rejects(joinDatasets(...snapshots(), {...options, leftField: 'missing'}), /Choose a match/);
 await assert.rejects(joinDatasets(...snapshots(), {...options, maxRows: 0}), /Maximum output/);
 const preview = await joinDatasets(...snapshots(), {...options, maxRows: 1}); assert.equal(preview.report.outputRows, 5);
 await assert.rejects(joinDatasets(...snapshots(), {...options, maxRows: 1}, '', true), /above the 1 row limit/);
 await assert.rejects(joinDatasets(joinSnapshot(store([['z']]), null), joinSnapshot(b, null), options, '', true), /no rows/);
 let cancelled = false;
 await assert.rejects(joinDatasets(...snapshots(), options, '', true, () => cancelled, () => { cancelled = true; }), /cancelled/);
 const empty = store([]); const result = await joinDatasets(joinSnapshot(a, null), joinSnapshot(empty, null), {...options, mode:'left'}, '', true);
 assert.equal(result.report.outputRows, 4);
});
test('joins across packed source chunks and CSV output batches without losing rows', async () => {
 const schema = [{name:'key',kind:'number'}, {name:'label',kind:'string'}];
 const left = new Store(schema), right = new Store(schema);
 for (const source of [left, right]) {
  for (let start = 0; start < 20001; start += 4096) source.append(Array.from({length: Math.min(4096, 20001-start)}, (_, k) => ({id: start+k, geometry:{type:'Point',coordinates:[-1,54]}, properties:{key:start+k,label:`row-${start+k}`}})));
  source.finish();
 }
 const result = await joinDatasets(structuredClone(joinSnapshot(left,null)), structuredClone(joinSnapshot(right,null)), {...options,maxRows:30000}, '', true);
 assert.equal(result.report.outputRows, 20001);
 const csv = parseCSV(await result.blob.text()); assert.equal(csv.rows.length,20001);
 assert.equal(csv.rows.at(-1)[csv.headers.indexOf('right.label')], 'row-20000');
});
