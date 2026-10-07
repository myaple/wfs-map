import { navigate } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';

async function seed(page: Page) {
    const config = { ...defaultConfig, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: '' };
    await page.addInitScript(({ config }) => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'categories', name: 'Categories', enabled: true, config: { ...config, csvText: 'lon,lat,label\n' + Array.from({ length: 240 }, (_, i) => `-1,54,Category-${String(i).padStart(3, '0')}`).join('\n') + '\n-1,54,' }, coloring: { field: 'label', bins: 8, low: '#000000', high: '#ffffff', categories: { label: { 'Category-000': '#ff0000' } } } },
        { id: 'gradient', name: 'Gradient', enabled: true, config: { ...config, csvText: 'lon,lat,value\n-2,53,0\n-2,53,16\n-2,53,' }, coloring: { scheme: 'viridis', field: 'value', bins: 8, low: '#000000', high: '#ffffff' } },
        { id: 'solid', name: 'Solid', enabled: true, color: [0, 1, 0], config: { ...config, csvText: 'lon,lat,value\n-3,52,1' } },
        { id: 'disabled', name: 'Disabled', enabled: false, config: { ...config, csvText: 'lon,lat,value\n-3,52,1' } }
    ], background: { url: '', attribution: '', enabled: false } })), { config });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.filter((s: any) => s.enabled).every((s: any) => s.done && (!s.coloring.field || s.colorCategories || s.colorLabels)));
}

const source = (page: Page, id: string) => page.locator(`.map-legend-source[data-source="${id}"]`);
const expand = async (page: Page, id: string) => { await source(page, id).locator('summary').click(); await expect(source(page, id).locator('details')).toHaveAttribute('open', ''); await expect(source(page, id).locator('.map-legend-row').first()).toBeVisible(); };

test('compact dataset summaries expand exact values with bounded DOM and move with enlargement', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await seed(page);
    const legend = page.getByRole('complementary', { name: 'Map legend', exact: true });
    await expect(legend).toBeVisible();
    expect((await legend.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator('#map').boundingBox())!.y + (await page.locator('#map').boundingBox())!.height);
    await expect(legend.locator('.map-legend-source')).toHaveCount(3);
    await expect(legend.locator('details[open]')).toHaveCount(0);
    await expect(legend.locator('.map-legend-row')).toHaveCount(0);
    await expect(source(page, 'solid').locator('.map-legend-preview')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
    await expect(source(page, 'gradient').locator('.map-legend-preview')).toHaveCSS('background-image', /linear-gradient/);
    await expect(source(page, 'disabled')).toHaveCount(0);
    await page.locator('#fit').click();
    await legend.screenshot({ path: 'docs/screenshots/compact-map-legend.png' });
    await expand(page, 'categories');
    const viewport = source(page, 'categories').locator('.map-legend-viewport');
    const first = source(page, 'categories').locator('.map-legend-row').first();
    await expect(first).toContainText('Category-000');
    await expect(first.locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(255, 0, 0)');
    expect(await legend.locator('.map-legend-row').count()).toBeLessThan(20);
    await viewport.evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(source(page, 'categories')).toContainText('Category-239');
    await expect(source(page, 'categories').locator('.map-legend-row').filter({ hasText: 'Missing value' }).locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(128, 128, 128)');
    await expand(page, 'gradient');
    await source(page, 'gradient').locator('.map-legend-viewport').evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(source(page, 'gradient').locator('.map-legend-row').filter({ hasText: '14 – 16' }).locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(253, 231, 37)');
    await page.locator('#enlargeMap').click();
    await expect(page.locator('.map-dialog #map #mapLegend')).toBeVisible();
    const map = (await page.locator('#map').boundingBox())!, overlay = (await legend.boundingBox())!;
    expect(overlay.x).toBeGreaterThanOrEqual(map.x); expect(overlay.y).toBeGreaterThanOrEqual(map.y);
    expect(overlay.y + overlay.height).toBeLessThan(map.y + map.height);
    await legend.screenshot({ path: 'docs/screenshots/expanded-map-legend.png' });
    await page.setViewportSize({ width: 375, height: 700 });
    expect(await legend.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-panel > #mapLegend')).toBeVisible();
    await expect(source(page, 'gradient').locator('details')).toHaveAttribute('open', '');
    expect(errors).toEqual([]);
});

test('legend preserves expansions and full colour domains through edits, filters, disabling and dark mode', async ({ page }) => {
    await seed(page);
    await expand(page, 'categories');
    await page.locator('#colorSource').selectOption('categories');
    await page.getByLabel('Colour for Category-000', { exact: true }).fill('#00ffff');
    await expect(source(page, 'categories').locator('.map-legend-row').first().locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 255)');
    await expect(source(page, 'categories').locator('.map-legend-preview')).toHaveCSS('background-image', /rgb\(0, 255, 255\)/);
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('categories', [{ field: 'label', op: 'eq', value: 'Category-000' }]));
    await expect(page.locator('#filterStatus')).toContainText('1 matches');
    await source(page, 'categories').locator('.map-legend-viewport').evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(source(page, 'categories')).toContainText('Category-239');
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('#mapLegend')).toHaveCSS('background-color', 'rgb(26, 38, 50)');
    await expand(page, 'gradient');
    const lowestBin = source(page, 'gradient').locator('.map-legend-row').filter({ hasText: '0 – 2' });
    await page.locator('#colorSource').selectOption('gradient'); await page.locator('#colorScheme').selectOption('inferno');
    await expect(lowestBin.locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(0, 0, 4)');
    await navigate(page, 'configuration');
    await page.getByLabel('Enable Categories', { exact: true }).uncheck(); await page.locator('#saveSettings').click();
    await navigate(page, 'analysis');
    await expect(source(page, 'categories')).toHaveCount(0);
    await expect(source(page, 'gradient').locator('details')).toHaveAttribute('open', '');
    await expect(lowestBin).toBeVisible();
});

test('visibility switches hide only map rendering and picking, preserving selections and page-session state', async ({ page }) => {
    await seed(page);
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.every((s: any) => !s.filtering));
    const snapshot = () => page.evaluate(() => ({ sources: (window as any).__WFS_MAP__.sources.map((s: any) => ({ id: s.id, enabled: s.enabled, selected: s.selected, request: s.filterRequest, expression: s.workspace.expression(), charts: s.workspace.specs, colorRequest: s.colorRequest, indices: Array.from(s.layer.indices ?? []) })), settings: localStorage.getItem('wfs-settings'), analysis: localStorage.getItem('wfs-analysis') }));
    const before = await snapshot();
    await expand(page, 'gradient');
    await source(page, 'gradient').locator('.map-legend-row').first().click();
    expect(await snapshot()).toEqual(before);
    const summary = source(page, 'gradient').locator('summary');
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(source(page, 'gradient').locator('details')).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await expect(source(page, 'gradient').locator('details')).toHaveAttribute('open', '');
    const visibility = () => page.evaluate(() => (window as any).__WFS_MAP__.sources.filter((s: any) => s.enabled).map((s: any) => s.layer.visible));
    const picks = () => page.evaluate(() => { const app = (window as any).__WFS_MAP__, p = app.map.project([-2, 53]); return app.sources.find((s: any) => s.id === 'gradient').layer.pickAll(p.x, p.y).length; });
    expect(await picks()).toBeGreaterThan(0);
    await page.getByRole('switch', { name: 'Show Gradient on map', exact: true }).uncheck();
    expect(await visibility()).toEqual([true, false, true]); expect(await picks()).toBe(0);
    expect(await snapshot()).toEqual(before);
    await expect(source(page, 'gradient')).toBeVisible();
    await page.locator('#exportSource').selectOption('gradient');
    const downloaded = page.waitForEvent('download'); await page.locator('#exportCSV').click();
    const file = await downloaded;
    const { readFile } = await import('node:fs/promises');
    expect((await readFile((await file.path())!, 'utf8')).trim().split('\n')).toHaveLength(4);
    await expect(page.locator('#csvExportStatus')).toContainText('3 points exported');
    await page.locator('#enlargeMap').click();
    await expect(page.getByRole('switch', { name: 'Show Gradient on map', exact: true })).not.toBeChecked();
    await page.keyboard.press('Escape');
    // Keyboard expansion and switch are independent and retain focus.
    const toggle = page.getByRole('switch', { name: 'Show Gradient on map', exact: true });
    await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeFocused();
    expect(await visibility()).toEqual([true, true, true]); expect(await picks()).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    for (const name of ['Categories', 'Gradient', 'Solid']) await page.getByRole('switch', { name: `Show ${name} on map`, exact: true }).uncheck();
    expect(await visibility()).toEqual([false, false, false]); expect(await snapshot()).toEqual(before);
    await navigate(page, 'records');
    await expect(page.locator('#recordsSource option')).toHaveCount(3);
    await page.locator('#recordsSource').selectOption('gradient');
    await expect(page.locator('#records [role=status]')).toContainText('3 table rows · 3 applied matches');
    await navigate(page, 'analysis');
    await page.locator('#cancel').click(); await page.locator('#load').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.filter((s: any) => s.enabled).every((s: any) => s.done));
    expect(await visibility()).toEqual([false, false, false]);
    await toggle.check(); expect(await picks()).toBeGreaterThan(0);
});

test('eight datasets produce eight collapsed entries even with categorical domains', async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: Array.from({ length: 8 }, (_, i) => ({ id: `source-${i}`, name: `Dataset ${i + 1}`, enabled: true, config: { ...config, type: 'csv', csvText: 'lon,lat,label\n-1,54,A\n-2,53,B', longitudeField: 'lon', latitudeField: 'lat', timeField: '' }, coloring: { field: 'label', bins: 8 } })), background: { enabled: false, url: '', attribution: '' } })), defaultConfig);
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && s.colorCategories));
    await expect(page.locator('.map-legend-source')).toHaveCount(8);
    await expect(page.locator('.map-legend-row')).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(8);
    await page.locator('#mapLegend').screenshot({ path: 'docs/screenshots/eight-dataset-map-legend.png' });
});

const settledMask = async (page: Page, id: string) => page.waitForFunction(id => !(window as any).__WFS_MAP__.sources.find((s: any) => s.id === id).mapMaskPending, id);
const valueToggle = (page: Page, name: string) => page.getByRole('switch', { name, exact: true });

test('legend redraws preserve keyboard focus without stealing it from other controls', async ({ page }) => {
    await seed(page); await expand(page, 'categories');
    const viewport = source(page, 'categories').locator('.map-legend-viewport');
    const toggle = valueToggle(page, 'Show Category-000 for Categories on map');
    const resize = async (height: number) => viewport.evaluate(async (el, height) => {
        el.style.height = `${height}px`;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, height);
    await toggle.focus();
    await resize(176);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space'); await settledMask(page, 'categories');
    await expect(toggle).not.toBeChecked(); await expect(toggle).toBeFocused();
    await resize(132);
    await expect(toggle).toBeFocused(); await expect(toggle).not.toBeChecked();
    // A pending observer callback must not refocus the legend after the user leaves it.
    await page.locator('#fit').focus(); await resize(88);
    await expect(page.locator('#fit')).toBeFocused();
});

test('category switches hide exact values, preserve focus, and survive scrolling, palette edits and source switches', async ({ page }) => {
    await seed(page); await expand(page, 'categories');
    await page.locator('#colorSource').selectOption('categories');
    // Sharing an RGB colour must not merge two category visibility choices.
    await page.getByLabel('Colour for Category-001', { exact: true }).fill('#ff0000');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.find((s: any) => s.id === 'categories').layer.colorCodes[3] === 255);
    const snapshot = () => page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => ({ id: s.id, enabled: s.enabled, count: s.selected, expression: s.workspace.expression(), request: s.filterRequest, charts: s.workspace.specs })));
    const before = await snapshot();
    const toggle = valueToggle(page, 'Show Category-000 for Categories on map');
    await toggle.focus(); await page.keyboard.press('Space'); await settledMask(page, 'categories');
    await expect(toggle).toBeFocused();
    const hits = () => page.evaluate(() => { const app = (window as any).__WFS_MAP__, p = app.map.project([-1,54]); return Array.from(app.sources.find((s: any) => s.id === 'categories').layer.pickAll(p.x,p.y)); });
    expect(await hits()).not.toContain(0); expect(await hits()).toContain(1); expect(await hits()).toHaveLength(240);
    const viewport = source(page,'categories').locator('.map-legend-viewport');
    await viewport.evaluate(el => el.scrollTop = el.scrollHeight);
    await valueToggle(page,'Show Missing value for Categories on map').uncheck(); await settledMask(page,'categories');
    expect(await hits()).toHaveLength(239);
    await viewport.evaluate(el => el.scrollTop = 0); await expect(toggle).not.toBeChecked();
    await valueToggle(page,'Show Categories on map').uncheck(); expect(await hits()).toHaveLength(0);
    await valueToggle(page,'Show Categories on map').check(); expect(await hits()).toHaveLength(239);
    expect(await snapshot()).toEqual(before);
    await page.getByLabel('Colour for Category-000',{exact:true}).fill('#00ffff'); await settledMask(page,'categories');
    await expect(toggle).not.toBeChecked(); expect(await hits()).not.toContain(0);
    await page.locator('#enlargeMap').click(); await expect(toggle).not.toBeChecked();
    await page.locator('#mapLegend').screenshot({ path:'docs/screenshots/expanded-map-legend.png' });
    await page.keyboard.press('Escape');
    await page.locator('#cancel').click(); await page.locator('#load').click();
    await page.waitForFunction(() => { const s=(window as any).__WFS_MAP__.sources.find((s:any)=>s.id==='categories');return s.done && s.layer.mapMask && !s.mapMaskPending; });
    expect(await hits()).toHaveLength(239); await expect(toggle).not.toBeChecked();
    await toggle.check(); await settledMask(page,'categories'); expect(await hits()).toHaveLength(240);
});

test('numeric and missing switches compose with filters but preserve chart, record and export selections', async ({ page }) => {
    await seed(page); await expand(page,'gradient');
    const picks=()=>page.evaluate(()=>{const app=(window as any).__WFS_MAP__,s=app.sources.find((s:any)=>s.id==='gradient'),p=app.map.project([-2,53]);return {cpu:Array.from(s.layer.pickAll(p.x,p.y)),gpu:s.layer.pick(p.x,p.y),selected:s.selected,filter:s.filterRequest};});
    const before=await picks();expect(before.cpu).toEqual([0,1,2]);
    await valueToggle(page,'Show 0 – 2 for Gradient on map').uncheck(); await settledMask(page,'gradient');
    expect((await picks()).cpu).toEqual([1,2]); expect((await picks()).filter).toBe(before.filter);
    await source(page,'gradient').locator('.map-legend-viewport').evaluate(el=>el.scrollTop=el.scrollHeight);
    await valueToggle(page,'Show 14 – 16 for Gradient on map').uncheck(); await settledMask(page,'gradient');
    await valueToggle(page,'Show Missing value for Gradient on map').uncheck(); await settledMask(page,'gradient');
    expect((await picks()).cpu).toEqual([]); expect((await picks()).gpu).toBeNull(); expect((await picks()).selected).toBe(3);
    await page.locator('#exportSource').selectOption('gradient');
    const download=page.waitForEvent('download'); await page.locator('#exportCSV').click();
    const file=await download;const {readFile}=await import('node:fs/promises');
    expect((await readFile((await file.path())!,'utf8')).trim().split('\n')).toHaveLength(4);
    await page.evaluate(()=>(window as any).__WFS_MAP__.filterSource('gradient',[{field:'value',op:'gte',value:'10'}]));
    await page.waitForFunction(()=>{const s=(window as any).__WFS_MAP__.sources.find((s:any)=>s.id==='gradient');return !s.filtering&&s.selected===1;});
    expect((await picks()).cpu).toEqual([]);
    await valueToggle(page,'Show 14 – 16 for Gradient on map').check(); await settledMask(page,'gradient');
    expect((await picks()).cpu).toEqual([1]);expect((await picks()).gpu).toBe(1);expect((await picks()).selected).toBe(1);
    await navigate(page,'records');await page.locator('#recordsSource').selectOption('gradient');
    await expect(page.locator('#records [role=status]')).toContainText('1 table rows · 1 applied matches');
});

test('rapid subcategory changes settle on the latest mask, preserve palette edits and reset for a new bin domain', async({page})=>{
    await seed(page);await expand(page,'gradient');
    const toggle=valueToggle(page,'Show 0 – 2 for Gradient on map');
    await toggle.uncheck();await toggle.check();await toggle.uncheck();await settledMask(page,'gradient');
    expect(await page.evaluate(()=>Array.from((window as any).__WFS_MAP__.sources.find((s:any)=>s.id==='gradient').layer.mapMask))).toEqual([0,1,1]);
    await page.locator('#colorSource').selectOption('gradient');await page.locator('#colorScheme').selectOption('inferno');
    await expect(toggle).not.toBeChecked();
    await page.locator('#colorBins').selectOption('24');
    await page.waitForFunction(()=>{const s=(window as any).__WFS_MAP__.sources.find((s:any)=>s.id==='gradient');return s.colorLabels?.length===24;});
    expect(await page.evaluate(()=>(window as any).__WFS_MAP__.sources.find((s:any)=>s.id==='gradient').layer.mapMask)).toBeUndefined();
    await expect(source(page,'gradient').locator('.map-legend-row input').first()).toBeChecked();
});
