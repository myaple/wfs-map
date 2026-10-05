import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';

const point = (id: number) => ({ type: 'Feature', id: `point.${id}`, geometry: { type: 'Point', coordinates: [-1 + id * .1, 54] }, properties: { value: id, category: 'point' } });
const cases = [
    { name: 'growing totals exceed the initial allocation', hits: 2, totals: [2, 5, 6], sizes: [2, 2, 1] },
    { name: 'shrinking totals allow an early empty page', hits: 10, totals: [10, 4], sizes: [2, 1] },
    { name: 'zero hits still loads available features', hits: 0, totals: [0, 0], sizes: [2, 1] },
    { name: 'stale low totals never terminate paging', hits: 1, totals: [1, 1, 1], sizes: [2, 2, 1] },
    { name: 'unknown totals load normally', hits: 'unknown', totals: ['unknown', 'unknown'], sizes: [2, 1] },
    { name: 'server page caps are not treated as exhaustion', hits: 9, totals: [9, 9, 9], sizes: [1, 1, 1] },
    { name: 'empty dataset with stale hits completes', hits: 8, totals: [], sizes: [] },
    { name: 'client limit stops growing data', hits: 2, totals: [2, 2, 9], sizes: [2, 2, 2], limit: 4 },
];
for (const format of ['json', 'gml']) for (const scenario of cases) test(`${format}: ${scenario.name}`, async ({ page }) => {
    const errors: string[] = [], requests: { offset: number; count: number; sort: string | null }[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const limit = scenario.limit ?? 12;
    await page.addInitScript(({ config, format, limit }) => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'paged', name: 'Paged points', enabled: true, config: { ...config, url: '/paging-wfs', layer: 'demo:points',
            format: format === 'json' ? 'application/json' : 'application/gml+xml; version=3.2', sort: 'value', pageSize: '2', limit: String(limit) } },
    ], background: { enabled: false, url: '', attribution: '' } })), { config: defaultConfig, format, limit });
    await page.route('**/paging-wfs?*', async route => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('request') === 'DescribeFeatureType') return route.fulfill({ status: 404, body: 'No schema' });
        if (params.get('resultType') === 'hits') return route.fulfill({ contentType: 'application/xml', body: `<FeatureCollection numberMatched="${scenario.hits}"/>` });
        const offset = Number(params.get('startIndex')), count = Number(params.get('count')), index = requests.length;
        requests.push({ offset, count, sort: params.get('sortBy') });
        const features = Array.from({ length: Math.min(scenario.sizes[index] ?? 0, count) }, (_, i) => point(offset + i));
        const total = scenario.totals[index] ?? scenario.hits;
        if (format === 'json') return route.fulfill({ contentType: 'application/json', json: { type: 'FeatureCollection', numberMatched: total, features } });
        const members = features.map(f => `<wfs:member><d:points gml:id="${f.id}"><d:geom><gml:Point><gml:pos>${f.geometry.coordinates.join(' ')}</gml:pos></gml:Point></d:geom><d:value>${f.properties.value}</d:value><d:category>point</d:category></d:points></wfs:member>`).join('');
        return route.fulfill({ contentType: 'application/gml+xml', body: `<wfs:FeatureCollection xmlns:wfs="urn:wfs" xmlns:gml="urn:gml" xmlns:d="urn:demo" numberMatched="${total}">${members}</wfs:FeatureCollection>` });
    });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => { const s = (window as any).__WFS_MAP__?.sources[0]; return s?.done || s?.error; });
    const loaded = Math.min(limit, scenario.sizes.reduce((sum, n) => sum + n, 0)), truncated = loaded === limit;
    const state = await page.evaluate(() => {
        const s = (window as any).__WFS_MAP__.sources[0], layer = s.layer, gl = layer.gl;
        // Verify both buffers retain old pages after growth, as well as new pages.
        const saved = gl.getParameter(gl.COPY_READ_BUFFER_BINDING), positions = new Float32Array(layer.count * 4), indices = new Uint32Array(layer.count);
        gl.bindBuffer(gl.COPY_READ_BUFFER, layer.positionBuffer); if (positions.length) gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, positions);
        gl.bindBuffer(gl.COPY_READ_BUFFER, layer.spatialBuffer); if (indices.length) gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, indices);
        gl.bindBuffer(gl.COPY_READ_BUFFER, saved);
        return { done: s.done, error: s.error, loaded: s.loaded, total: s.total, status: s.status, warning: s.metrics.warning,
            truncated: s.metrics.truncated, capacity: layer.capacity, gpuError: gl.getError(),
            positions: Array.from(positions), indices: Array.from(indices),
            expectedPositions: layer.chunks.flatMap((c: any) => Array.from(c.positions)), expectedIndices: layer.chunks.flatMap((c: any) => Array.from(c.indices)) };
    });
    expect(state.error, state.status).toBe(false); expect(state.done).toBe(true); expect(state.loaded).toBe(loaded);
    expect(state.truncated).toBe(truncated); if (!truncated) expect(state.total).toBe(loaded);
    expect(state.warning).toBe(''); expect(state.status).not.toMatch(/changed|snapshot|premature|Warning/i);
    expect(state.capacity).toBeGreaterThanOrEqual(loaded); expect(state.capacity).toBeLessThanOrEqual(limit);
    expect(state.gpuError).toBe(0); expect(state.positions).toEqual(state.expectedPositions); expect(state.indices).toEqual(state.expectedIndices);
    expect(requests.every(r => r.sort === 'value A' && r.count <= Math.min(2, limit - r.offset))).toBe(true);
    const offsets: number[] = []; let offset = 0;
    for (const n of scenario.sizes) { if (offset >= limit) break; offsets.push(offset); offset += Math.min(n, limit - offset); }
    if (!truncated) offsets.push(loaded);
    expect(requests.map(r => r.offset)).toEqual(offsets); expect(errors).toEqual([]);
});

for (const failure of ['repeated page', 'duplicate ID', 'ignored count']) test(`pagination still rejects ${failure}`, async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'bad', name: 'Bad paging', enabled: true, config: { ...config, url: '/bad-paging-wfs', layer: 'demo:points', sort: 'value', pageSize: '2', limit: '12' } },
    ] })), defaultConfig);
    await page.route('**/bad-paging-wfs?*', async route => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('request') === 'DescribeFeatureType') return route.fulfill({ status: 404, body: 'No schema' });
        if (params.get('resultType') === 'hits') return route.fulfill({ contentType: 'application/xml', body: '<FeatureCollection numberMatched="1"/>' });
        const offset = Number(params.get('startIndex'));
        const ids = failure === 'ignored count' ? [0, 1, 2] : !offset || failure === 'repeated page' ? [0, 1] : [1, 2];
        return route.fulfill({ contentType: 'application/json', json: { type: 'FeatureCollection', numberMatched: offset ? 5 : 1, features: ids.map(point) } });
    });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0].error);
    await expect(page.locator('#status')).toContainText(failure === 'repeated page' ? 'Server repeated a page' : failure === 'duplicate ID' ? 'Repeated feature ID' : 'Server ignored the requested page count');
});
