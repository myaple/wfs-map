import { test, expect } from '@playwright/test';
import { navigate } from '../navigation.ts';
import { defaultConfig } from '../../src/source-settings.ts';

const point = (id: number) => ({ type: 'Feature', id: `point.${id}`, geometry: { type: 'Point', coordinates: [-1 + id * .1, 54] }, properties: { value: id, category: 'point' } });
type PagingCase = { name: string; hits?: number | string; totals: (number | string | undefined)[]; sizes: number[]; limit?: number; short?: boolean; version?: string };
const cases: PagingCase[] = [
    { name: 'growing totals exceed the initial allocation', hits: 2, totals: [2, 5, 6], sizes: [2, 2, 1] },
    { name: 'shrinking totals allow an early empty page', hits: 10, totals: [10, 4], sizes: [2, 1] },
    { name: 'zero hits still loads available features', hits: 0, totals: [0, 0], sizes: [2, 1] },
    { name: 'stale low totals never terminate paging', hits: 1, totals: [1, 1, 1], sizes: [2, 2, 1] },
    { name: 'unknown totals load normally', hits: 'unknown', totals: ['unknown', 'unknown'], sizes: [2, 1] },
    { name: 'server page caps are not treated as exhaustion', hits: 9, totals: [9, 9, 9], sizes: [1, 1, 1] },
    { name: 'empty dataset with stale hits completes', hits: 8, totals: [], sizes: [] },
    { name: 'short page stops a live feed with growing totals', hits: 2, totals: [5, 8, 12], sizes: [2, 1, 2, 2, 2], short: true },
    { name: 'short page stops with unknown totals', hits: 'unknown', totals: ['unknown'], sizes: [2, 1, 2, 2], short: true },
    { name: 'short page stops without hits or page totals', totals: [], sizes: [2, 1, 2, 2], short: true },
    { name: 'short first page stops without totals', totals: [], sizes: [1, 2, 2], short: true },
    { name: 'empty-page mode works without hits or page totals', totals: [], sizes: [2, 1, 2] },
    { name: 'short-page mode still stops at the point limit', hits: 'unknown', totals: [], sizes: [2, 1, 2], limit: 3, short: true },
    { name: 'WFS 1.0 short page stops without totals', totals: [], sizes: [2, 1, 2], short: true, version: '1.0.0' },
    { name: 'WFS 1.1 short page stops without totals', totals: [], sizes: [2, 1, 2], short: true, version: '1.1.0' },
    { name: 'client limit stops growing data', hits: 2, totals: [2, 2, 9], sizes: [2, 2, 2], limit: 4 },
];
for (const format of ['json', 'gml']) for (const scenario of cases) test(`${format}: ${scenario.name}`, async ({ page }) => {
    const errors: string[] = [], requests: { offset: number; count: number; sort: string | null }[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const limit = scenario.limit ?? 12;
    await page.addInitScript(({ config, format, limit, short, version }) => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'paged', name: 'Paged points', enabled: true, config: { ...config, url: '/paging-wfs', layer: 'demo:points',
            format: format === 'json' ? 'application/json' : 'application/gml+xml; version=3.2', sort: 'value', pageSize: '2', limit: String(limit), pagingEnd: short ? 'short' : 'empty', version } },
    ], background: { enabled: false, url: '', attribution: '' } })), { config: defaultConfig, format, limit, short: scenario.short, version: scenario.version ?? '2.0.0' });
    await page.route('**/paging-wfs?*', async route => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('request') === 'DescribeFeatureType') return route.fulfill({ status: 404, body: 'No schema' });
        if (params.get('resultType') === 'hits' && scenario.hits === undefined) return route.fulfill({ status: 404, body: 'No hits support' });
        if (params.get('resultType') === 'hits') return route.fulfill({ contentType: 'application/xml', body: `<FeatureCollection numberMatched="${scenario.hits}"/>` });
        const offset = Number(params.get('startIndex')), count = Number(params.get('count') ?? params.get('maxFeatures')), index = requests.length;
        requests.push({ offset, count, sort: params.get('sortBy') });
        const features = Array.from({ length: Math.min(scenario.sizes[index] ?? 0, count) }, (_, i) => point(offset + i));
        const total = scenario.totals[index] ?? scenario.hits;
        if (format === 'json') return route.fulfill({ contentType: 'application/json', json: { type: 'FeatureCollection', ...(total === undefined ? {} : { numberMatched: total }), features } });
        const members = features.map(f => `<wfs:member><d:points gml:id="${f.id}"><d:geom><gml:Point><gml:pos>${f.geometry.coordinates.join(' ')}</gml:pos></gml:Point></d:geom><d:value>${f.properties.value}</d:value><d:category>point</d:category></d:points></wfs:member>`).join('');
        return route.fulfill({ contentType: 'application/gml+xml', body: `<wfs:FeatureCollection xmlns:wfs="urn:wfs" xmlns:gml="urn:gml" xmlns:d="urn:demo"${total === undefined ? '' : ` numberMatched="${total}"`}>${members}</wfs:FeatureCollection>` });
    });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => { const s = (window as any).__WFS_MAP__?.sources[0]; return s?.done || s?.error; });
    const offsets: number[] = []; let loaded = 0, shortPage = false;
    for (const size of scenario.sizes) {
        if (loaded >= limit || shortPage) break;
        offsets.push(loaded);
        const requested = Math.min(2, limit - loaded), returned = Math.min(size, requested);
        loaded += returned; shortPage = !!scenario.short && returned < requested;
    }
    const truncated = loaded === limit;
    if (!truncated && !shortPage) offsets.push(loaded);
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
    const completion = scenario.short ? 'short page or limit' : 'empty page or limit';
    expect(state.warning).toBe(scenario.version === '1.0.0' ? `WFS 1.0 has no standard hits count; loading until ${completion}.` : scenario.hits === undefined ? `GetFeature hits unavailable; loading until ${completion}.` : ''); expect(state.status).not.toMatch(/changed|snapshot|premature|Warning/i);
    expect(state.capacity).toBeGreaterThanOrEqual(loaded); expect(state.capacity).toBeLessThanOrEqual(limit);
    expect(state.gpuError).toBe(0); expect(state.positions).toEqual(state.expectedPositions); expect(state.indices).toEqual(state.expectedIndices);
    expect(requests.every(r => r.sort === 'value A' && r.count <= Math.min(2, limit - r.offset))).toBe(true);
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

test('paging completion is per source, defaults for older settings, and persists through editing and reload', async ({ page }) => {
    await page.addInitScript(config => {
        // An older saved source has no pagingEnd setting.
        const { pagingEnd, ...legacy } = config;
        if (!localStorage.getItem('wfs-settings')) localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
            { id: 'live', name: 'Live feed', enabled: false, config: { ...legacy, url: '/wfs', layer: 'demo:points' } },
            { id: 'capped', name: 'Capped server', enabled: false, config: { ...legacy, url: '/wfs', layer: 'demo:points' } },
        ] }));
    }, defaultConfig);
    await page.goto('/?time=all');
    await navigate(page, 'configuration');
    await page.getByRole('button', { name: 'Configure Live feed', exact: true }).click();
    await page.locator('#wfsCompatibility > summary').click();
    await expect(page.getByLabel('Stop paging', { exact: true })).toHaveValue('empty');
    await page.getByLabel('Stop paging', { exact: true }).selectOption('short');
    await page.locator('#updateSource').click();
    await page.locator('#saveSettings').click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!).sources.map((s: any) => s.config.pagingEnd))).toEqual(['short', 'empty']);
    await page.reload();
    await navigate(page, 'configuration');
    for (const [name, mode] of [['Live feed', 'short'], ['Capped server', 'empty']]) {
        await page.getByRole('button', { name: 'Configure ' + name, exact: true }).click();
        await page.locator('#wfsCompatibility > summary').click();
        await expect(page.getByLabel('Stop paging', { exact: true })).toHaveValue(mode);
        await page.locator('#closeSource').click();
    }
});
