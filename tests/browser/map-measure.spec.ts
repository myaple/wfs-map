import { test, expect, type Page } from '@playwright/test';
import { mapDistance, type MapLocation } from '../../src/map-distance.ts';
import { openFilters } from '../navigation.ts';

const start: MapLocation = [-1.552, 53.996], end: MapLocation = [-1.54, 54.000];
async function fixture(page: Page) {
    await page.addInitScript(() => localStorage.setItem('wfs-settings', JSON.stringify({
        sources: [{ id: 'local', name: 'Harrogate', enabled: true, config: {
            type: 'csv', csvText: 'lon,lat\n-1.552,53.996\n-1.54,54.000', longitudeField: 'lon', latitudeField: 'lat', url: ''
        } }], background: { url: '', attribution: '', enabled: false }, map: { center: [-1.546, 53.998], zoom: 14, pointSize: 5 }
    })));
    await page.goto('/?time=all');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    // Loading can fit the dataset. Use a known camera for real pointer clicks.
    await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-1.546, 53.998], zoom: 14 }));
    await page.locator('#map').scrollIntoViewIfNeeded();
    await page.evaluate(() => { (window as any).__measureClicks = []; (window as any).__WFS_MAP__.map.on('click', (e: any) => (window as any).__measureClicks.push([e.lngLat.lng, e.lngLat.lat])); });
}
async function position(page: Page, coordinates: MapLocation) {
    return page.evaluate(c => {
        const m = (window as any).__WFS_MAP__.map, p = m.project(c), r = m.getCanvas().getBoundingClientRect();
        return { x: r.x + p.x, y: r.y + p.y };
    }, coordinates);
}
async function clickLocation(page: Page, coordinates: MapLocation) {
    const p = await position(page, coordinates); await page.mouse.click(p.x, p.y);
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Measured distance', exact: true });

for (const deviceScaleFactor of [1, 2]) test.describe(`measure at DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });
    test('two clicks preview and lock distance; pan, zoom, enlargement and dismissal preserve the result', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
        await fixture(page);
        const requests: string[] = []; page.on('request', r => { if (new URL(r.url()).searchParams.has('request')) requests.push(r.url()); });
        const button = page.getByRole('button', { name: 'Measure distance', exact: true });
        expect(await button.evaluate(el => el.previousElementSibling?.id)).toBe('toggleEllipses');
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.map-measure-help')).toHaveText('Click the first point');
        await clickLocation(page, start);
        await expect(page.locator('.map-measure-help')).toHaveText('Click the second point');
        const second = await position(page, end); await page.mouse.move(second.x, second.y);
        await expect(page.locator('.map-measure-line path')).toHaveAttribute('d', /^M .+ L .+$/);
        await expect(dialog(page)).toBeHidden();
        await page.mouse.click(second.x, second.y);
        await expect(dialog(page)).toBeVisible();
        const clicked = await page.evaluate(() => (window as any).__measureClicks.slice(0, 2)) as MapLocation[];
        const distance = mapDistance(clicked[0], clicked[1]);
        for (const [unit, value] of Object.entries(distance)) {
            const number = Number((await page.locator(`[data-unit="${unit}"]`).textContent())!.replaceAll(',', ''));
            expect(number).toBeCloseTo(value, 1);
        }
        const locked = await dialog(page).textContent();
        await clickLocation(page, [-1.544, 53.995]);
        await expect(dialog(page)).toHaveText(locked!);
        const oldPath = await page.locator('.map-measure-line path').getAttribute('d');
        await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-1.545, 53.998], zoom: 14.5 }));
        await expect(page.locator('.map-measure-line path')).not.toHaveAttribute('d', oldPath!);
        await expect(dialog(page)).toHaveText(locked!);
        const projected = await page.evaluate(c => {
            const m = (window as any).__WFS_MAP__.map, a = m.project(c[0]), b = m.project(c[1]);
            return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
        }, clicked);
        // The actual click coordinates can differ by subpixels from projected targets.
        const actual = (await page.locator('.map-measure-line path').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        const expected = projected.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThan(1));
        if (deviceScaleFactor === 1) await page.locator('.map-panel').screenshot({ path: 'docs/screenshots/map-measure.png' });
        await page.locator('#enlargeMap').click();
        await expect(dialog(page)).toBeVisible(); await expect(dialog(page)).toHaveText(locked!);
        if (deviceScaleFactor === 1) await page.locator('.map-dialog').screenshot({ path: 'docs/screenshots/map-measure-enlarged.png' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('themechange')); });
        await expect(dialog(page)).toBeVisible();
        const bounds = await dialog(page).boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await page.getByRole('button', { name: 'Close measurement' }).click();
        await expect(dialog(page)).toBeHidden(); await expect(button).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('.map-measure')).toBeHidden();
        await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-1.546, 53.998], zoom: 13 }));
        await button.click(); await clickLocation(page, start); await clickLocation(page, end); await button.click();
        await expect(dialog(page)).toBeHidden(); await expect(page.locator('.map-measure-line path')).not.toHaveAttribute('d');
        await page.locator('#enlargeMap').click();
        expect(await page.evaluate(() => { const h = (window as any).__WFS_MAP__; return { query: h.queryBounds.bbox ?? null, local: h.localMapBounds ?? null, selected: h.sources[0].selected }; })).toEqual({ query: null, local: null, selected: 2 });
        expect(requests).toEqual([]); expect(errors).toEqual([]);
    });
});

test('cancellation, zero distance and load-area drawing do not conflict with measuring', async ({ page }) => {
    await fixture(page);
    const button = page.locator('#measureMap');
    await button.click(); await clickLocation(page, start); await button.click();
    await expect(page.locator('.map-measure')).toBeHidden();
    await button.click();
    const p = await position(page, start); await page.mouse.click(p.x, p.y, { button: 'right' });
    await expect(page.locator('.map-measure-help')).toHaveText('Click the first point');
    await page.mouse.dblclick(p.x, p.y);
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('[data-unit="meters"]')).toHaveText('0');
    await expect(page.locator('.metadata-popup')).toHaveCount(0);
    await openFilters(page);
    await page.locator('#drawArea').click();
    await expect(dialog(page)).toBeHidden(); await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(page.locator('#drawArea')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#map').scrollIntoViewIfNeeded();
    await clickLocation(page, start); await clickLocation(page, end);
    await expect(dialog(page)).toBeVisible();
});

test('measurement is available before any dataset is loaded', async ({ page }) => {
    await page.goto('/?local=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await page.locator('#measureMap').click();
    const b = (await page.locator('#map canvas').boundingBox())!;
    await page.mouse.click(b.x + b.width * .35, b.y + b.height * .5);
    await page.mouse.click(b.x + b.width * .65, b.y + b.height * .6);
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('[data-unit="meters"]')).not.toHaveText('0');
});
