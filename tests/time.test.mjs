import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUTC, utcISO, formatUTC } from '../src/time.ts';
import { csvDataset } from '../src/csv.ts';
import { defaultConfig } from '../src/source-settings.ts';
import { decodePage, inferFields } from '../src/data.ts';
import { Store } from '../src/store.ts';
import { Analyzer, all } from '../src/analysis.ts';
import { exportCSV } from '../src/csv-export.ts';
import { queryFilter } from '../src/wfs-query.ts';

test('UTC parsing and all operations are independent of host timezone, including DST transitions', async () => {
    const original = process.env.TZ;
    try {
        for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Pacific/Auckland']) {
            process.env.TZ = zone;
            const unzoned = '2026-03-08T02:30:00'; // Missing local hour in New York.
            assert.equal(utcISO(unzoned), '2026-03-08T02:30:00.000Z');
            assert.equal(utcISO('2026-03-08 04:30:00+02:00'), utcISO(unzoned));
            assert.equal(utcISO('2026-03-07T21:30:00-0500'), utcISO(unzoned));
            assert.equal(utcISO('2026-03-08'), '2026-03-08T00:00:00.000Z');
            assert.equal(utcISO('2026-03-08+02:00'), '2026-03-07T22:00:00.000Z');
            assert.equal(formatUTC('2026-10-04T15:36:38+01:00'), '2026-10-04 14:36:38 UTC');
            const dataset = csvDataset({ ...defaultConfig, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: 'when', csvText: `lon,lat,when\n-1,54,${unzoned}\n-2,53,2026-03-08T04:30:00+02:00\n-3,52,2026-03-08T03:30:00Z` }, { time: { start: '2026-03-08 02:30:00', end: '2026-03-08 02:31:00' } });
            assert.equal(dataset.features.length, 2);
            const store = new Store(dataset.fields); store.append(dataset.features); store.finish();
            assert.equal(store.get(0).properties.when, utcISO(unzoned));
            assert.deepEqual([...(await store.filter([{ field: 'when', op: 'eq', value: unzoned }]))], [0, 1]);
            const { charts } = await new Analyzer(store).run(all([]), [{ id: 'time', type: 'time', x: 'when', bins: 8 }]);
            assert.equal(charts[0].x.labels[0], '2026-03-08 02:30:00 UTC');
            assert.match(await (await exportCSV(store, null)).text(), /2026-03-08T02:30:00.000Z/);
            const xml = queryFilter('2.0.0', { time: { start: unzoned, end: '2026-03-08T05:30:00+02:00' } }, { time: 'when', geometry: 'geom' });
            assert.match(xml, /2026-03-08T02:30:00.000Z/); assert.match(xml, /2026-03-08T03:30:00.000Z/);
        }
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('WFS GeoJSON and GML dates with and without offsets use the same UTC instant', () => {
    for (const text of [
        JSON.stringify({ type: 'FeatureCollection', features: ['2026-10-04T14:00:00', '2026-10-04T16:00:00+02:00'].map((when, id) => ({ id, geometry: { type: 'Point', coordinates: [-1, 54] }, properties: { when } })) }),
        '<FeatureCollection><member><point id="a"><geom><Point><pos>-1 54</pos></Point></geom><when>2026-10-04T14:00:00</when></point></member><member><point id="b"><geom><Point><pos>-1 54</pos></Point></geom><when>2026-10-04T16:00:00+02:00</when></point></member></FeatureCollection>'
    ]) {
        const { features } = decodePage(text), store = new Store(inferFields(features));
        store.append(features); store.finish();
        assert.deepEqual(store.fields, [{ name: 'when', kind: 'date' }]);
        assert.equal(store.get(0).properties.when, '2026-10-04T14:00:00.000Z');
        assert.equal(store.get(1).properties.when, store.get(0).properties.when);
    }
});

test('invalid dates and ambiguous local formats never silently roll over or use local time', () => {
    for (const value of ['2026-02-29', '2026-02-30T12:00:00', '2026-13-01', '2026-01-01T24:00:00', '2026-01-01T00:60:00', '2026-01-01T00:00:00+15:00', '2026-01-01T00:00:00+02:60', '10/04/2026 2:00 PM', 'not a date', '']) {
        assert.ok(Number.isNaN(parseUTC(value)), value);
        assert.throws(() => utcISO(value));
    }
    assert.equal(utcISO('2024-02-29T23:59:59.123Z'), '2024-02-29T23:59:59.123Z');
});
