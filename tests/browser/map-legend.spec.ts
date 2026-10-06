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

test('legend shows exact colours for every enabled source, scrolls all values and moves with enlargement', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await seed(page);
    const legend = page.getByRole('complementary', { name: 'Map legend', exact: true });
    const viewport = page.locator('.map-legend-viewport');
    await expect(legend).toBeVisible();
    expect((await legend.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator('#map').boundingBox())!.y + (await page.locator('#map').boundingBox())!.height);
    await expect(page.locator('#map #mapLegend')).toHaveCount(0);
    const first = legend.locator('.map-legend-row').first();
    await expect(first).toContainText('Category-000');
    await expect(first.locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(255, 0, 0)');
    expect(await viewport.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    // Virtual rows keep the DOM bounded while every value remains scrollable.
    expect(await legend.locator('.map-legend-row').count()).toBeLessThan(20);
    await viewport.evaluate(el => el.scrollTop = 235 * 44);
    await expect(legend).toContainText('Category-239');
    await expect(legend.locator('[data-source=categories]').filter({ hasText: 'Missing value' }).locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(128, 128, 128)');
    await viewport.evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(legend).toContainText('Solid');
    await expect(legend.locator('[data-source=solid] .map-legend-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
    await expect(legend.locator('[data-source=gradient]').filter({ hasText: '14 – 16' }).locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(253, 231, 37)');
    await expect(legend.locator('[data-source=disabled]')).toHaveCount(0);
    await viewport.evaluate(el => el.scrollTop = 0);
    await page.locator('#enlargeMap').click();
    await expect(page.locator('.map-dialog #map #mapLegend')).toBeVisible();
    const map = (await page.locator('#map').boundingBox())!, overlay = (await legend.boundingBox())!;
    expect(overlay.x).toBeGreaterThanOrEqual(map.x); expect(overlay.y).toBeGreaterThanOrEqual(map.y);
    expect(overlay.y + overlay.height).toBeLessThan(map.y + map.height);
    await viewport.evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(legend).toContainText('Solid');
    await page.setViewportSize({ width: 375, height: 700 });
    expect(await legend.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.map-panel > #mapLegend')).toBeVisible();
    await page.locator('#enlargeMap').click(); await page.locator('#enlargeMap').click();
    await expect(page.locator('.map-panel > #mapLegend')).toBeVisible();
    expect(errors).toEqual([]);
});

test('legend tracks palette edits, filters, disabled sources and dark mode', async ({ page }) => {
    // Exercise delayed routing: content assertions also pass while Analysis is
    // hidden, but scrolling its virtual legend at that point is ineffective.
    await page.addInitScript(() => {
        const add = window.addEventListener.bind(window);
        window.addEventListener = ((type, listener, options) => {
            if (type === 'hashchange' && typeof listener === 'function') {
                add(type, event => setTimeout(() => listener.call(window, event), 750), options);
            } else add(type, listener, options);
        }) as typeof window.addEventListener;
    });
    await seed(page);
    await page.locator('#colorSource').selectOption('categories');
    await page.getByLabel('Colour for Category-000', { exact: true }).fill('#00ffff');
    await page.getByLabel('Colour for Category-000', { exact: true }).dispatchEvent('change');
    await expect(page.locator('.map-legend-row').first().locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 255)');
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('categories', [{ field: 'label', op: 'eq', value: 'Category-000' }]));
    await expect(page.locator('#filterStatus')).toContainText('1 matches');
    await page.locator('.map-legend-viewport').evaluate(el => el.scrollTop = 235 * 44);
    await expect(page.locator('#mapLegend')).toContainText('Category-239');
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('#mapLegend')).toHaveCSS('background-color', 'rgb(26, 38, 50)');
    await navigate(page, 'configuration');
    await page.getByLabel('Enable Categories', { exact: true }).uncheck();
    await page.locator('#saveSettings').click();
    await navigate(page, 'analysis');
    await expect(page.locator('#mapLegend')).toBeVisible();
    await expect(page.locator('#mapLegend')).not.toContainText('Categories');
    await expect(page.locator('#mapLegend')).toContainText('Gradient');
    await page.locator('.map-legend-viewport').evaluate(el => el.scrollTop = 0);
    // Wait for the virtual list to render the lowest bin after scrolling.
    // DOM order includes overscan rows and is not a stable bin identifier.
    const lowestBin = page.locator('[data-source=gradient]').filter({ has: page.getByText('0 – 2', { exact: true }) });
    await expect(lowestBin).toBeVisible();
    await page.locator('#colorSource').selectOption('gradient');
    await page.locator('#colorScheme').selectOption('inferno');
    await expect(lowestBin.locator('.map-legend-swatch')).toHaveCSS('background-color', 'rgb(0, 0, 4)');
    await expect(page.locator('.map-legend-viewport')).toHaveJSProperty('scrollTop', 0);
});


test('legend buttons select exact categories, numeric edges and missing values in the owning source without WFS reload', async ({ page }) => {
    await seed(page);
    let requests = 0; page.on('request', r => { if (new URL(r.url()).pathname === '/wfs') requests++; });
    const indices = (id: string) => page.evaluate(id => Array.from((window as any).__WFS_MAP__.sources.find((s: any) => s.id === id).layer.indices ?? []), id);
    const ready = () => page.waitForFunction(() => (window as any).__WFS_MAP__.sources.every((s: any) => !s.filtering));
    const clear = async (id: string) => { await page.evaluate(id => { const h = (window as any).__WFS_MAP__; h.sources.find((s: any) => s.id === id).workspace.clearFilters(); }, id); await ready(); };
    await page.getByRole('button', { name: 'Filter Categories: Category-000', exact: true }).click();
    await ready(); expect(await indices('categories')).toEqual([0]);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.find((s: any) => s.id === 'gradient').selected)).toBe(3);
    await clear('categories');
    await page.locator('.map-legend-viewport').evaluate(el => el.scrollTop = 237 * 44);
    await page.getByRole('button', { name: 'Filter Categories: Missing value', exact: true }).click();
    await ready(); expect(await indices('categories')).toEqual([240]);
    await page.getByRole('button', { name: 'Filter Gradient: 0 – 2', exact: true }).focus(); await page.keyboard.press('Enter');
    await ready(); expect(await indices('gradient')).toEqual([0]);
    await clear('gradient');
    await page.locator('.map-legend-viewport').evaluate(el => el.scrollTop = el.scrollHeight);
    await page.locator('#enlargeMap').click();
    await page.locator('.map-legend-viewport').evaluate(el => el.scrollTop = el.scrollHeight);
    await page.getByRole('button', { name: 'Filter Gradient: 14 – 16', exact: true }).click();
    await ready(); expect(await indices('gradient')).toEqual([1]);
    await clear('gradient');
    await page.getByRole('button', { name: 'Filter Gradient: Missing value', exact: true }).click();
    await ready(); expect(await indices('gradient')).toEqual([2]);
    await page.keyboard.press('Escape');
    expect(requests).toBe(0);
});

test('numeric legend bin predicates match colour codes at every edge and Log10 grey values', async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [{ id: 'edges', name: 'Edges', enabled: true,
        config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', csvText: 'lon,lat,value\n' + [-1,0,1,2,4,8,16,32,64,128,256,null].map(v => `-1,54,${v ?? ''}`).join('\n') },
        coloring: { field: 'value', bins: 8, low: '#000000', high: '#ffffff' } }], background: { url: '', attribution: '', enabled: false } })), defaultConfig);
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.colorLabels?.length === 8);
    for (const scale of ['linear', 'log10']) {
        await page.locator('#colorScale').selectOption(scale);
        await expect(page.locator('#colorLegend')).toContainText(scale === 'log10' ? 'Log10' : 'grey = missing');
        const expected = await page.evaluate(() => { const s = (window as any).__WFS_MAP__.sources[0]; return { codes: Array.from(s.layer.colorCodes) as number[], labels: [...s.colorLabels] }; });
        for (let bin = 0; bin <= 8; bin++) {
            await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].workspace.clearFilters());
            await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
            await page.locator('.map-legend-viewport').evaluate((el, bin) => el.scrollTop = bin * 44, bin);
            const label = bin < 8 ? expected.labels[bin] : scale === 'log10' ? 'Missing / non-positive value' : 'Missing value';
            await page.getByRole('button', { name: `Filter Edges: ${label}`, exact: true }).click();
            await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
            const actual = await page.evaluate(() => Array.from((window as any).__WFS_MAP__.layer.indices));
            expect(actual).toEqual(expected.codes.flatMap((code, i) => code === (bin < 8 ? bin : 255) ? [i] : []));
        }
    }
});
