import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDistance } from '../src/map-distance.ts';

test('surface distance has exact feet and nautical-mile conversions', () => {
    const distance = mapDistance([0, 0], [1, 0]);
    assert.ok(Math.abs(distance.meters - 111195.0802335329) < 1e-6);
    assert.equal(distance.feet * 0.3048, distance.meters);
    assert.equal(distance.nauticalMiles * 1852, distance.meters);
    assert.deepEqual(mapDistance([1, 0], [0, 0]), distance);
    assert.deepEqual(mapDistance([-1.546, 53.998], [-1.546, 53.998]), { feet: 0, meters: 0, nauticalMiles: 0 });
});

test('distance accounts for latitude, the dateline and antipodal rounding', () => {
    const equator = mapDistance([0, 0], [1, 0]).meters;
    const northern = mapDistance([0, 60], [1, 60]).meters;
    assert.ok(Math.abs(northern / equator - 0.5) < 0.00001);
    assert.ok(Math.abs(mapDistance([179.9, 0], [-179.9, 0]).meters - equator / 5) < 1e-6);
    assert.ok(Math.abs(mapDistance([0, 0], [180, 0]).meters - Math.PI * 6371008.8) < 1e-6);
    assert.ok(Number.isFinite(mapDistance([10, 20], [190, -20]).meters));
});
