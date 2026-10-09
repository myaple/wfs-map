import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';

const point = (id: number) => ({ type: 'Feature', id: `point.${id}`, geometry: { type: 'Point', coordinates: [-1 + id * .001, 54] }, properties: { value: id, major: id + 1, minor: .5, angle: 90 } });
const scenarios = [
    { name: 'default 10 with out-of-order pages', concurrency: undefined, size: 27, version: '2.0.0' },
    { name: 'per-source maximum 3', concurrency: '3', size: 27, version: '2.0.0' },
    { name: 'short final page with later failures', concurrency: '3', size: 5, short: true, tailFailure: true, version: '2.0.0' },
    { name: 'empty end with later failures', concurrency: '3', size: 6, tailFailure: true, version: '2.0.0' },
    { name: 'server cap below requested count', concurrency: '3', size: 13, cap: true, version: '2.0.0' },
    { name: 'changing server caps rebuild offsets', concurrency: '3', size: 13, changingCap: true, version: '2.0.0' },
    { name: 'client limit has a smaller final request', concurrency: '3', size: 100, limit: 7, version: '2.0.0' },
    { name: 'WFS 1.0 parallel paging', concurrency: '3', size: 13, version: '1.0.0' },
    { name: 'WFS 1.1 parallel paging', concurrency: '3', size: 13, version: '1.1.0' },
];
for (const format of ['json', 'gml']) for (const scenario of scenarios) test(`${format}: ${scenario.name}`, async ({ page }) => {
    const requests: { offset: number; count: number }[] = [], completed: number[] = [], errors: string[] = [];
    let active = 0, peak = 0;
    page.on('pageerror', error => errors.push(error.message));
    const limit = scenario.limit ?? 41, pageSize = scenario.cap || scenario.changingCap ? 4 : 2;
    await page.addInitScript(({ config, scenario, format, limit, pageSize }) => {
        const source = { ...config, url: '/parallel-wfs', layer: 'demo:points', sort: 'value', pageSize: String(pageSize), limit: String(limit),
            version: scenario.version, pagingEnd: scenario.short ? 'short' : 'empty', format: format === 'json' ? 'application/json' : 'application/gml+xml',
            ellipseMajorField: 'major', ellipseMinorField: 'minor', ellipseOrientationField: 'angle' };
        if (scenario.concurrency === undefined) delete (source as any).maxParallelRequests;
        else source.maxParallelRequests = scenario.concurrency;
        localStorage.setItem('wfs-settings', JSON.stringify({ sources: [{ id: 'parallel', name: 'Parallel points', enabled: true, config: source }], background: { enabled: false, url: '', attribution: '' } }));
    }, { config: defaultConfig, scenario, format, limit, pageSize });
    await page.route('**/parallel-wfs?*', async route => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('request') === 'DescribeFeatureType') return route.fulfill({ status: 404, body: 'No schema' });
        if (params.get('resultType') === 'hits') return route.fulfill({ contentType: 'application/xml', body: '<FeatureCollection numberMatched="1"/>' });
        const offset = Number(params.get('startIndex')), count = Number(params.get(scenario.version === '2.0.0' ? 'count' : 'maxFeatures'));
        requests.push({ offset, count }); active++; if (!completed.includes(2)) peak = Math.max(peak, active);
        expect(params.get('sortBy')).toBe('value A');
        // Hold the first page in each window while later pages return first.
        await new Promise(resolve => setTimeout(resolve, offset === 0 ? 0 : offset === 2 ? 200 : 80));
        active--; completed.push(offset);
        if (scenario.tailFailure && offset > scenario.size) return route.fulfill({ status: 503, body: 'Past the end' });
        const cap = scenario.cap ? 1 : scenario.changingCap ? offset === 0 ? 2 : offset < 3 ? 1 : 3 : Infinity;
        const features = Array.from({ length: Math.max(0, Math.min(count, cap, scenario.size - offset)) }, (_, i) => point(offset + i));
        // Totals grow, shrink, and remain below the loaded count; they cannot stop paging.
        const total = offset % 4 ? 'unknown' : offset ? 99 : 0;
        if (format === 'json') return route.fulfill({ contentType: 'application/json', json: { type: 'FeatureCollection', numberMatched: total, features } });
        const members = features.map(f => `<wfs:member><d:points gml:id="${f.id}"><d:geom><gml:Point><gml:pos>${f.geometry.coordinates.join(' ')}</gml:pos></gml:Point></d:geom><d:value>${f.properties.value}</d:value><d:major>${f.properties.major}</d:major><d:minor>${f.properties.minor}</d:minor><d:angle>90</d:angle></d:points></wfs:member>`).join('');
        return route.fulfill({ contentType: 'application/gml+xml', body: `<wfs:FeatureCollection xmlns:wfs="urn:wfs" xmlns:gml="urn:gml" xmlns:d="urn:demo" numberMatched="${total}">${members}</wfs:FeatureCollection>` });
    });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => { const s = (window as any).__WFS_MAP__?.sources[0]; return s?.done || s?.error; });
    const state = await page.evaluate(async () => {
        const s = (window as any).__WFS_MAP__.sources[0];
        if (s.error) return { error: s.status };
        const values = await new Promise<number[]>(resolve => {
            const listener = (event: MessageEvent) => {
                if (event.data.type !== 'metadataMany' || event.data.token !== 'parallel-test') return;
                s.worker.removeEventListener('message', listener);
                resolve(event.data.rows.map((r: any) => Number(r.data.properties.value)));
            };
            s.worker.addEventListener('message', listener);
            s.worker.postMessage({ type: 'getMany', token: 'parallel-test', indices: Array.from({ length: s.loaded }, (_, i) => i) });
        });
        return { done: s.done, loaded: s.loaded, values, total: s.total, truncated: s.metrics.truncated,
            parallel: s.config.maxParallelRequests, ellipses: s.layer.chunks.flatMap((c: any) => Array.from(c.ellipses ?? [])) };
    });
    const loaded = Math.min(scenario.size, limit);
    expect(state.error).toBeUndefined(); expect(state.done).toBe(true); expect(state.loaded).toBe(loaded);
    expect(state.values).toEqual(Array.from({ length: loaded }, (_, i) => i));
    expect(state.truncated).toBe(loaded === limit); if (loaded < limit) expect(state.total).toBe(loaded);
    expect(state.parallel).toBe(scenario.concurrency ?? '10');
    expect(state.ellipses).toHaveLength(loaded * 4);
    expect(requests.every(r => r.offset < limit && r.count === Math.min(pageSize, limit - r.offset))).toBe(true);
    if (!scenario.cap && !scenario.changingCap) {
        const concurrency = Number(scenario.concurrency ?? '10');
        expect(peak).toBeLessThanOrEqual(concurrency);
        if (scenario.size === 27) { expect(peak).toBe(concurrency); expect(completed.indexOf(4)).toBeLessThan(completed.indexOf(2)); }
    }
    expect(errors).toEqual([]);
});
