import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvInferencePatch, inferCSVFields } from '../src/csv-inference.ts';
import { defaultConfig } from '../src/source-settings.ts';
const columns = ['position_east', 'position_north', 'observed_at', 'sma_nm', 'smi_m', 'ellipse_azimuth_deg'];
const prediction = value => ({ value, probability: .9, candidates: [{ value, probability: .9 }] });
const result = { available: true, fields: Object.fromEntries(Object.entries({ longitudeField: columns[0], latitudeField: columns[1], timeField: columns[2], ellipseMajorField: columns[3], ellipseMinorField: columns[4], ellipseOrientationField: columns[5], ellipseMajorUnit: 'nm', ellipseMinorUnit: 'm' }).map(([k,v]) => [k, prediction(v)])) };
const config = () => ({ ...defaultConfig, longitudeField: '', latitudeField: '', timeField: '' });
test('CSV suggestions map only valid headers and independently selected axis units', () => {
    const c = config();
    assert.deepEqual(csvInferencePatch(result, columns, c, c), Object.fromEntries(Object.entries(result.fields).map(([k,p]) => [k,p.value])));
    const invalid = structuredClone(result); invalid.fields.latitudeField.value = 'not-in-file'; invalid.fields.timeField.probability = NaN;
    const patch = csvInferencePatch(invalid, columns, c, c);
    assert.equal(patch.latitudeField, undefined); assert.equal(patch.timeField, undefined);
});
test('saved mappings and manual changes, including changing back, are preserved', () => {
    const c = config(), current = { ...c, timeField: 'sma_nm' };
    assert.equal(csvInferencePatch(result, columns, c, current).timeField, undefined);
    assert.equal(csvInferencePatch(result, columns, c, c, undefined, new Set(['timeField'])).timeField, undefined);
    const saved = { ...c, latitudeField: 'smi_m', ellipseMajorUnit: 'm' };
    const patch = csvInferencePatch(result, columns, saved, saved, saved);
    assert.equal(patch.latitudeField, undefined); assert.equal(patch.ellipseMajorUnit, undefined);
});
test('incomplete ellipse suggestions and duplicate field assignments do not make invalid mappings', () => {
    const c = config(), partial = structuredClone(result); partial.fields.ellipseOrientationField.value = null;
    const patch = csvInferencePatch(partial, columns, c, c);
    for (const key of ['ellipseMajorField', 'ellipseMinorField', 'ellipseMajorUnit', 'ellipseMinorUnit']) assert.equal(patch[key], undefined);
    const duplicate = structuredClone(result); duplicate.fields.latitudeField.value = duplicate.fields.longitudeField.value;
    const duplicates = csvInferencePatch(duplicate, columns, c, c);
    assert.equal(duplicates.longitudeField, undefined); assert.equal(duplicates.latitudeField, undefined);
});
test('manual axis edit prevents a late unit suggestion for the other column', () => {
    const c = { ...config(), ellipseMajorField: 'sma_nm', ellipseMinorField: 'smi_m', ellipseOrientationField: 'ellipse_azimuth_deg' };
    const patch = csvInferencePatch(result, columns, c, { ...c, ellipseMajorField: 'position_east' }, undefined, new Set(['ellipseMajorField']));
    assert.equal(patch.ellipseMajorField, undefined); assert.equal(patch.ellipseMajorUnit, undefined);
});
test('optional inference sends only headers and silently falls back for disabled/failing APIs', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async (url, request) => { assert.equal(url, '/api/csv/infer-fields'); assert.deepEqual(JSON.parse(request.body), { columns }); return new Response(JSON.stringify(result)); };
        assert.deepEqual(await inferCSVFields(columns, new AbortController().signal), result);
        for (const response of [new Response('{}', { status: 503 }), new Response('not JSON'), new Response(JSON.stringify({ available: false, fields: {} }))]) {
            globalThis.fetch = async () => response;
            assert.equal(await inferCSVFields(columns, new AbortController().signal), undefined);
        }
        globalThis.fetch = async () => { throw Error('offline'); };
        assert.equal(await inferCSVFields(columns, new AbortController().signal), undefined);
    } finally { globalThis.fetch = original; }
});
