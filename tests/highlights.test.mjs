import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, all } from '../src/analysis.ts';
import { Store } from '../src/store.ts';
import { inferFields } from '../src/data.ts';
import { feature } from '../server/demo.ts';
import { configureHighlights, highlightedRows, replaceHighlights, selectHighlights, forgetHighlights } from '../src/highlights.ts';

test('highlight bins use exact existing numeric/date/log/category axes and applied rows across chunks', async () => {
    const features = Array.from({ length: 400 }, (_, i) => {
        const f = feature(i);
        f.properties.category = i === 0 ? 'Other categories' : `category-${i % 40}`;
        f.properties.value = i % 17 === 0 ? null : i % 13 === 0 ? 0 : 10 ** ((i % 40) / 10);
        return f;
    });
    const store = new Store(inferFields(features));
    store.append(features.slice(0, 151)); store.append(features.slice(151));
    const analyzer = new Analyzer(store);
    for (const spec of [
        { type: 'bar', x: 'category' },
        { type: 'pie', x: 'category' },
        { type: 'bar', x: 'active' },
        { type: 'time', x: 'timestamp' },
        { type: 'scatter', x: 'value', y: 'quality', xScale: 'log10' },
    ]) {
        const chart = (await analyzer.run(all([]), [{ ...spec, id: 'chart', bins: 16 }])).charts[0];
        const rows = Uint32Array.from({ length: 400 }, (_, i) => i);
        assert.deepEqual(await analyzer.highlightCounts(chart, rows, null), chart.counts);
        const applied = (await analyzer.run({ field: 'active', op: 'eq', value: 'true' }, [])).indices;
        const expected = (await analyzer.run({ field: 'active', op: 'eq', value: 'true' }, [{ ...spec, id: 'chart', bins: 16 }])).charts[0];
        assert.deepEqual(await analyzer.highlightCounts(chart, rows, applied), expected.counts);
        for (const cell of [0, chart.counts.length - 1]) {
            const matches = await analyzer.chartRows(chart, [cell], null);
            const projected = await analyzer.highlightCounts(chart, matches, null);
            assert.equal(matches.length, chart.counts[cell]);
            assert.equal(projected[cell], matches.length);
            assert.equal(projected.reduce((a, b) => a + b, 0), matches.length);
        }
    }
});

test('highlight replacement, clearing and source reload discard stale asynchronous selections', async () => {
    let finish;
    configureHighlights({ select: () => new Promise(resolve => finish = resolve), counts: async () => new Uint32Array() });
    replaceHighlights(new Map([['a', Uint32Array.of(1, 2)]]));
    const pending = selectHighlights([{ sourceId: 'a', expression: all([]) }]);
    assert.equal(highlightedRows.size, 0);
    replaceHighlights(new Map([['b', Uint32Array.of(1)]]));
    finish(Uint32Array.of(8)); await pending;
    assert.deepEqual([...highlightedRows.keys()], ['b']);
    const reload = selectHighlights([{ sourceId: 'a', expression: all([]) }]);
    forgetHighlights('a'); finish(Uint32Array.of(2)); await reload;
    assert.equal(highlightedRows.size, 0);
    replaceHighlights(); assert.equal(highlightedRows.size, 0);
});
