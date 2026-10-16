import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayColors, overlayDefaults, validateOverlayConfig, isValidGeoJSON, overlayWarning } from '../src/overlays.ts';
import { defaultConfig, validateConfig, configIdentity, settingsMetadata } from '../src/source-settings.ts';

const point = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-1, 54] } };
const line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-2, 53], [-1, 54]] } };
const polygon = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-2, 53], [-1, 53], [-1, 54], [-2, 53]]] } };
const collection = { type: 'FeatureCollection', features: [point, line, polygon] };

test('overlay config validates colours from the list and required keys', () => {
    assert.doesNotThrow(() => validateOverlayConfig({ ...overlayDefaults }));
    assert.doesNotThrow(() => validateOverlayConfig({ ...overlayDefaults, overlayColor: overlayColors[overlayColors.length - 1].id }));
    assert.throws(() => validateOverlayConfig({ ...overlayDefaults, overlayColor: '#ff0000' }), /overlay colour/);
    assert.throws(() => validateOverlayConfig({ overlayGeoJSON: '', overlayFileName: '' }), /Invalid overlay settings/);
});

test('isValidGeoJSON accepts features, collections and geometries and rejects other JSON', () => {
    assert.ok(isValidGeoJSON(JSON.stringify(collection)));
    assert.ok(isValidGeoJSON(JSON.stringify(point)));
    assert.ok(isValidGeoJSON(JSON.stringify({ type: 'Point', coordinates: [-1, 54] })));
    assert.ok(isValidGeoJSON(JSON.stringify({ type: 'GeometryCollection', geometries: [] })));
    assert.ok(!isValidGeoJSON('{"type":"FeatureCollection","features":{}}'));
    assert.ok(!isValidGeoJSON('{"type":"Feature"}'));
    assert.ok(!isValidGeoJSON('{"type":"Nonsense"}'));
    assert.ok(!isValidGeoJSON('not json'));
    assert.ok(!isValidGeoJSON('[1,2,3]'));
    assert.ok(!isValidGeoJSON('42'));
});

test('overlayWarning reports point features that follow the point size slider', () => {
    assert.equal(overlayWarning(JSON.stringify(collection)), '1 point feature use the point size slider; lines and polygons use the overlay colour.');
    assert.equal(overlayWarning(JSON.stringify({ type: 'FeatureCollection', features: [point, { ...point, geometry: { type: 'MultiPoint', coordinates: [[-1, 54], [-2, 53]] } }] })), '2 point features use the point size slider; lines and polygons use the overlay colour.');
    assert.equal(overlayWarning(JSON.stringify(line)), '');
    assert.equal(overlayWarning('not json'), '');
});

test('validateConfig accepts a valid overlay and rejects invalid files and colours', () => {
    const base = { ...defaultConfig, type: 'overlay', overlayGeoJSON: JSON.stringify(collection), overlayColor: overlayColors[0].id };
    assert.doesNotThrow(() => validateConfig(base));
    assert.throws(() => validateConfig({ ...base, overlayGeoJSON: '' }), /Choose a GeoJSON file/);
    assert.throws(() => validateConfig({ ...base, overlayGeoJSON: '{"a":1}' }), /not valid GeoJSON/);
    assert.throws(() => validateConfig({ ...base, overlayColor: 'red' }), /overlay colour/);
});

test('overlay configs keep identity and metadata behaviour consistent with CSV files', () => {
    const inline = { ...defaultConfig, type: 'overlay', overlayGeoJSON: JSON.stringify(collection) };
    const referenced = { ...defaultConfig, type: 'overlay', csvRef: 'ref-1', overlayGeoJSON: JSON.stringify(collection) };
    // An inline overlay compares by content; a saved overlay compares by reference.
    assert.equal(configIdentity(referenced), configIdentity({ ...referenced, overlayGeoJSON: '{"changed":true}' }));
    assert.notEqual(configIdentity(inline), configIdentity({ ...inline, overlayGeoJSON: '{"changed":true}' }));
    // Metadata strips inline contents but keeps the file reference, like CSV.
    const settings = { sources: [{ id: 'o1', name: 'Overlay', enabled: true, config: referenced }], background: { url: '', attribution: '', enabled: false } };
    const metadata = settingsMetadata(settings);
    assert.equal(metadata.sources[0].config.overlayGeoJSON, '');
    assert.equal(metadata.sources[0].config.csvRef, 'ref-1');
});
