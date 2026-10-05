import { navigate, openFilters } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';
import { feature } from '../../server/demo.ts';
const now = new Date('2026-10-02T12:00:00Z');
const config = { url: '/wfs?points=8192&vendor=keep', layer: 'demo:points', version: '2.0.0', format: 'application/json', srs: 'urn:ogc:def:crs:OGC:1.3:CRS84', axis: 'xy', sort: '', pageSize: '2', limit: '1000' };
async function seed(page: Page, two = false) {
  await page.clock.setFixedTime(now);
  await page.addInitScript(({ config, two }) => {
    localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
      { id: 'first', name: 'First', enabled: true, config },
      ...(two ? [{ id: 'second', name: 'Second', enabled: true, config: { ...config, url: '/wfs?points=8192&distribution=dense' } }] : [])
    ], background: { url: '', attribution: '', enabled: false } }));
  }, { config, two });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.loading));
test('default 24 hours bounds every source, hits and page; ordinary filters make no WFS requests', async ({ page }) => {
  await seed(page, true);
  const requests: URL[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.searchParams.get('request') === 'GetFeature') requests.push(u); });
  await page.goto('/?autoload=1'); await ready(page);
  await expect(page.getByLabel('Time window', { exact: true })).toHaveValue('24');
  await openFilters(page);
  await page.locator('.filter-panel summary').click();
  await expect(page.getByLabel('Time window', { exact: true })).toBeVisible();
  await page.locator('.filter-panel summary').click();
  const start = now.getTime() - 86400000;
  const expected = Array.from({ length: 8192 }, (_, i) => feature(i)).filter(f => Date.parse(f.properties.timestamp) >= start && Date.parse(f.properties.timestamp) <= now.getTime()).length;
  expect(expected).toBeGreaterThan(2);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.loaded))).toEqual([expected, expected]);
  expect(requests.filter(u => u.searchParams.get('resultType') === 'hits')).toHaveLength(2);
  const filters = requests.map(u => u.searchParams.get('filter'));
  expect(new Set(filters).size).toBe(1);
  expect(filters[0]).toContain('2026-10-01T12:00:00.000Z');
  expect(filters[0]).toContain('2026-10-02T12:00:00.000Z');
  expect(requests.some(u => u.searchParams.get('startIndex') === '2')).toBe(true);
  expect(requests.filter(u => !u.searchParams.has('distribution')).every(u => u.searchParams.get('vendor') === 'keep')).toBe(true);
  const before = requests.length;
  await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'eq', value: 'sensor' }, 'Sensors'));
  await expect(page.locator('#filterStatus')).toContainText('matches');
  await page.locator('#reset').click();
  await expect(page.locator('#filterStatus')).toContainText(`${expected} matches`);
  expect(requests).toHaveLength(before);
});
test('map area reloads every source with time AND BBOX and clearing restores the time-bounded set', async ({ page }) => {
  await seed(page, true);
  const filters: string[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.searchParams.get('request') === 'GetFeature') filters.push(u.searchParams.get('filter')!); });
  await page.goto('/?autoload=1'); await ready(page);
  const original = await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.loaded));
  await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-3, 54.5], zoom: 5 }));
  const canvas = page.locator('#map canvas'); await canvas.scrollIntoViewIfNeeded(); const b = (await canvas.boundingBox())!;
  filters.length = 0;
  await page.mouse.move(b.x + b.width * .25, b.y + b.height * .25);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(b.x + b.width * .75, b.y + b.height * .75, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await openFilters(page);
  await expect(page.locator('#clearArea')).toBeVisible(); await ready(page);
  const bounds = await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox);
  const expected = ['uk', 'dense'].map(distribution => Array.from({ length: 8192 }, (_, i) => feature(i, distribution)).filter(f => {
    const [x, y] = f.geometry.coordinates, t = Date.parse(f.properties.timestamp);
    return x >= bounds.west && x <= bounds.east && y >= bounds.south && y <= bounds.north && t >= now.getTime() - 86400000 && t <= now.getTime();
  }).length);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.loaded))).toEqual(expected);
  expect(filters.length).toBeGreaterThan(1);
  expect(filters.every(f => f.includes('<fes:And>') && f.includes('<fes:BBOX>') && f.includes('timestamp'))).toBe(true);
  await expect(page.locator('#rules .selection')).toHaveCount(0);
  filters.length = 0; await page.locator('#clearArea').click(); await ready(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.loaded))).toEqual(original);
  expect(filters.every(f => !f.includes('BBOX'))).toBe(true);
});
test('custom UTC ranges validate before requesting and an empty result retains its schema', async ({ page }) => {
  await seed(page); await page.goto('/?autoload=1'); await ready(page);
  const requests: string[] = []; page.on('request', r => requests.push(r.url()));
  await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ op: 'row', index: 0 }, 'Observation 1'));
  await expect(page.locator('#filterStatus')).toContainText('1 matches');
  await openFilters(page);
  await page.getByLabel('Time window', { exact: true }).selectOption('custom');
  await page.getByLabel('Start (UTC)', { exact: true }).fill('2030-01-02T00:00');
  await page.getByLabel('End (UTC)', { exact: true }).fill('2030-01-01T00:00');
  await page.getByRole('button', { name: 'Apply time range' }).click();
  await expect(page.locator('#timeError')).toContainText('start before the end'); expect(requests).toHaveLength(0);
  await page.getByLabel('End (UTC)', { exact: true }).fill('2030-01-03T00:00');
  await page.getByRole('button', { name: 'Apply time range' }).click(); await ready(page);
  await expect(page.locator('#status')).toContainText('0 points loaded');
  await expect(page.locator('#rules .selection')).toHaveCount(0);
  await expect(page.locator('#filterStatus')).not.toContainText('Filter error');
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].fields.some((f: any) => f.name === 'timestamp'))).toBe(true);
  await page.getByLabel('Time window', { exact: true }).selectOption('24'); await ready(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBeGreaterThan(0);
});
test('missing schema requires an explicit time override and never falls back to unbounded features', async ({ page }) => {
  await seed(page);
  const requests: URL[] = [];
  await page.route('**/wfs?*', async route => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('request') === 'DescribeFeatureType') await route.fulfill({ status: 404, body: 'No schema' });
    else { requests.push(u); await route.continue(); }
  });
  await page.goto('/?autoload=1');
  await expect(page.locator('#status')).toContainText('Choose a time attribute'); expect(requests).toHaveLength(0);
  await navigate(page, 'configuration'); await page.getByRole('button', { name: 'Configure First', exact: true }).click();
  await page.locator('#wfsCompatibility summary').click(); await page.getByLabel('Time attribute (optional override)', { exact: true }).fill('timestamp');
  await page.getByLabel('Geometry attribute (optional override)', { exact: true }).fill('geometry');
  await page.locator('#updateSource').click(); await page.locator('#saveSettings').click(); await ready(page);
  expect(requests.length).toBeGreaterThan(0); expect(requests.every(u => u.searchParams.get('filter')?.includes('timestamp'))).toBe(true);
});
test('superseded schema requests cannot clear or overwrite the replacement query', async ({ page }) => {
  await seed(page);
  let release!: () => void; const blocked = new Promise<void>(resolve => release = resolve); let first = true;
  await page.route('**/wfs?*', async route => {
    if (new URL(route.request().url()).searchParams.get('request') === 'DescribeFeatureType' && first) {
      first = false; await blocked; await route.fulfill({ status: 503, body: 'Old failure' }).catch(() => {});
    } else await route.continue();
  });
  await page.goto('/?autoload=1');
  await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0].loading);
  await openFilters(page);
  await page.getByLabel('Time window', { exact: true }).selectOption('6');
  release(); await ready(page);
  const state = await page.evaluate(() => { const h = (window as any).__WFS_MAP__; return { bounds: h.queryBounds, metrics: h.metrics, error: h.sources[0].error }; });
  expect(state.error).toBe(false);
  expect(state.bounds.time.start).toBe('2026-10-02T06:00:00.000Z');
  expect(state.metrics.queryBounds).toEqual(state.bounds);
});
