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
  await openFilters(page); await page.locator('#drawArea').click();
  const canvas = page.locator('#map canvas'); await canvas.scrollIntoViewIfNeeded(); const b = (await canvas.boundingBox())!;
  filters.length = 0;
  await page.mouse.move(b.x + b.width * .25, b.y + b.height * .25);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(b.x + b.width * .75, b.y + b.height * .75, { steps: 4 });
  await page.mouse.up({ button: 'left' });
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

async function dragArea(page: Page, button: 'right' | 'left', start = .25, end = .75) {
  const canvas = page.locator('#map canvas'); await canvas.scrollIntoViewIfNeeded();
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + b.width * start, b.y + b.height * .25);
  await page.mouse.down({ button });
  await page.mouse.move(b.x + b.width * end, b.y + b.height * .75, { steps: 4 });
  await page.mouse.up({ button });
}
const filtered = (page: Page) => page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
test('right-drag replaces one shared local area across sources and intersects OR filters without requests', async ({ page }) => {
  await seed(page, true);
  const requests: string[] = [];
  page.on('request', r => { if (new URL(r.url()).searchParams.get('request') === 'GetFeature') requests.push(r.url()); });
  await page.goto('/?autoload=1'); await filtered(page);
  await page.evaluate(() => {
    const h = (window as any).__WFS_MAP__;
    h.map.jumpTo({ center: [-3, 54.5], zoom: 5 });
    h.sources[0].workspace.restore({ op: 'or', children: [{ field: 'category', op: 'eq', value: 'sensor' }, { field: 'category', op: 'eq', value: 'event' }] }, h.sources[0].workspace.specs);
    h.filter();
  });
  await filtered(page);
  const original = await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => ({ loaded: s.loaded, selected: s.selected, request: s.request })));
  const before = requests.length;
  const expectedFor = (bounds: any) => ['uk', 'dense'].map((distribution, source) => Array.from({ length: 8192 }, (_, i) => feature(i, distribution)).filter(f => {
    const [x, y] = f.geometry.coordinates, t = Date.parse(f.properties.timestamp);
    return x >= bounds.west && x <= bounds.east && y >= bounds.south && y <= bounds.north && t >= now.getTime() - 86400000 && t <= now.getTime() && (source || ['sensor', 'event'].includes(f.properties.category));
  }).length);
  await dragArea(page, 'right', .2, .5); await filtered(page);
  const first = await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.selected))).toEqual(expectedFor(first));
  await dragArea(page, 'right', .5, .8); await filtered(page);
  const second = await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds);
  expect(second).not.toEqual(first);
  const expected = expectedFor(second);
  expect(expected.some(n => n > 0)).toBe(true);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.selected))).toEqual(expected);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => ({ loaded: s.loaded, request: s.request })))).toEqual(original.map(({ loaded, request }) => ({ loaded, request })));
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox)).toBeUndefined();
  expect(requests).toHaveLength(before);
  await openFilters(page);
  await expect(page.locator('#clearLocalArea')).toHaveCount(1);
  await expect(page.locator('#rules .selection')).toHaveCount(0);
  await page.locator('#clearLocalArea').click(); await filtered(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.selected))).toEqual(original.map(s => s.selected));
  expect(requests).toHaveLength(before);
});

test('load-area drawing can be cancelled and leaves the independent local area unchanged', async ({ page }) => {
  await seed(page); await page.goto('/?autoload=1'); await filtered(page);
  await dragArea(page, 'right'); await filtered(page);
  const local = await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds);
  const request = await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].request);
  await openFilters(page); await page.locator('#drawArea').click();
  await expect(page.locator('#drawArea')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawArea')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].request)).toBe(request);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox)).toBeUndefined();
  await openFilters(page); await page.locator('#drawArea').click();
  await dragArea(page, 'left'); await filtered(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox)).toBeDefined();
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds)).toEqual(local);
  await expect(page.locator('#drawArea')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#clearArea').click(); await filtered(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds)).toEqual(local);
});

for (const enlarged of [false, true]) test(`double-right-click clears every source's dataset filters and local area while preserving global bounds${enlarged ? ' in the enlarged map' : ''}`, async ({ page }) => {
  await seed(page, true);
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem('wfs-settings')!);
    settings.sources.push({ ...settings.sources[0], id: 'disabled', name: 'Disabled', enabled: false });
    localStorage.setItem('wfs-settings', JSON.stringify(settings));
  });
  await page.goto('/?autoload=1');
  await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.filter((s: any) => s.enabled).every((s: any) => s.done && !s.filtering));
  await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-3, 54.5], zoom: 5 }));
  await openFilters(page); await page.locator('#drawArea').click(); await dragArea(page, 'left');
  await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.filter((s: any) => s.enabled).every((s: any) => s.done && !s.filtering));
  await page.evaluate(() => {
    const h = (window as any).__WFS_MAP__;
    for (const s of h.sources) {
      s.workspace.restore({ op: 'and', children: [{ op: 'or', children: [{ field: 'category', op: 'eq', value: 'sensor' }, { field: 'category', op: 'eq', value: 'event' }] }] }, s.workspace.specs);
      if (s.enabled) s.workspace.select({ field: 'quality', op: 'gte', value: '50' }, 'Chart selection');
    }
  });
  await dragArea(page, 'right', .3, .6);
  await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.filter((s: any) => s.enabled).every((s: any) => !s.filtering));
  const before = await page.evaluate(() => { const h = (window as any).__WFS_MAP__; return { bounds: h.queryBounds, requests: h.sources.map((s: any) => s.request), specs: h.sources.map((s: any) => s.workspace.specs) }; });
  expect(before.bounds.bbox).toBeDefined(); expect(before.bounds.time).toBeDefined();
  let requests = 0; page.on('request', r => { if (new URL(r.url()).searchParams.get('request') === 'GetFeature') requests++; });
  if (enlarged) await page.locator('#enlargeMap').click();
  const b = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.dblclick(b.x + b.width * .5, b.y + b.height * .5, { button: 'right', delay: 50 });
  await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.filter((s: any) => s.enabled).every((s: any) => !s.filtering && s.selected === s.loaded));
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.workspace.expression()))).toEqual(Array(3).fill({ op: 'and', children: [] }));
  expect(await page.evaluate(() => { const h = (window as any).__WFS_MAP__; return { bounds: h.queryBounds, requests: h.sources.map((s: any) => s.request), specs: h.sources.map((s: any) => s.workspace.specs) }; })).toEqual(before);
  expect(requests).toBe(0);
  if (enlarged) await page.keyboard.press('Escape');
  await navigate(page, 'configuration');
  await page.getByRole('checkbox', { name: 'Enable Disabled', exact: true }).check();
  await page.locator('#saveSettings').click();
  await page.waitForFunction(() => {
    const s = (window as any).__WFS_MAP__.sources.find((s: any) => s.id === 'disabled');
    return s.enabled && s.done && !s.filtering && s.selected === s.loaded;
  });
  expect(await page.evaluate(() => {
    const s = (window as any).__WFS_MAP__.sources.find((s: any) => s.id === 'disabled');
    return { expression: s.workspace.expression(), roots: s.rules.querySelectorAll(':scope > .filter-group').length };
  })).toEqual({ expression: { op: 'and', children: [] }, roots: 1 });
});

test('single right-clicks and intervening drags never clear dataset filters', async ({ page }) => {
  await seed(page); await page.goto('/?autoload=1'); await filtered(page);
  await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'eq', value: 'sensor' }, 'Sensors'));
  await filtered(page);
  const b = (await page.locator('#map canvas').boundingBox())!;
  const x = b.x + b.width * .5, y = b.y + b.height * .5;
  await page.mouse.click(x, y, { button: 'right' });
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children.length)).toBe(1);
  await dragArea(page, 'right');
  await page.mouse.click(x, y, { button: 'right' });
  await filtered(page);
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.localMapBounds)).toBeDefined();
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children.length)).toBe(1);
});
