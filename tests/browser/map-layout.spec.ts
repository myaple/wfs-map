import { test, expect, type Page } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { navigate, openFilters, openTimeline } from '../navigation.ts';

async function seed(page: Page, count = 8) {
    await page.addInitScript(({ config, count }) => localStorage.setItem('wfs-settings', JSON.stringify({
        sources: Array.from({ length: count }, (_, i) => ({ id: `source-${i}`, name: `Dataset ${i + 1}`, enabled: true,
            config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: 'time',
                csvText: 'lon,lat,time,label\n' + Array.from({ length: 50 }, (_, j) => `${-2 + i / 10},${53 + j / 100},2026-10-08T12:00:00Z,Category ${j}`).join('\n') },
            coloring: { field: 'label', bins: 8 } }))
    })), { config: defaultConfig, count });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && s.colorCategories));
}

async function fits(page: Page) {
    await expect.poll(() => page.evaluate(() => {
        const panel = document.querySelector('.map-panel')!.getBoundingClientRect();
        const map = document.getElementById('map')!.getBoundingClientRect();
        const legend = document.getElementById('mapLegend')!.getBoundingClientRect();
        const dock = document.getElementById('workspaceDock')!.getBoundingClientRect();
        return panel.top >= 0 && panel.bottom <= dock.top - 10 && map.height > 0
            && legend.top >= map.bottom - 1 && legend.bottom <= panel.bottom;
    })).toBe(true);
    // The renderer follows the flex-sized map, rather than keeping its old canvas height.
    await expect.poll(() => page.locator('#map').evaluate(el => Math.abs(el.clientHeight - el.querySelector('canvas')!.clientHeight))).toBeLessThanOrEqual(1);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1024, height: 600 }, { width: 375, height: 700 }]) {
    test(`map and eight-source legend fit at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await seed(page);
        await fits(page);
        expect(await page.locator('#status').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        await expect(page.locator('#status')).toContainText('Dataset 8');
        if (viewport.width === 1440) {
            const height = (await page.locator('#map').boundingBox())!.height;
            await page.evaluate(() => window.scrollTo(0, 200));
            await fits(page);
            expect((await page.locator('#map').boundingBox())!.height).toBe(height);
            await page.evaluate(() => window.scrollTo(0, 0));
        }
        const list = page.locator('.map-legend-sources');
        expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        await page.locator('.map-legend-summary').first().click();
        await expect(page.locator('.map-legend-row').first()).toBeVisible();
        await fits(page);
        await list.evaluate(el => el.scrollTop = el.scrollHeight);
        await expect(page.getByRole('switch', { name: 'Show Dataset 8 on map', exact: true })).toBeInViewport();
        if (viewport.width === 1366) {
            await list.evaluate(el => el.scrollTop = 0);
            await page.locator('.map-legend-summary').first().click();
            await page.screenshot({ path: 'docs/screenshots/map-legend-fit-laptop.png' });
        }
    });
}

test('map budget follows panels, banners, resizing, navigation and enlargement', async ({ page }) => {
    await page.route('**/api/site-config', route => route.fulfill({ json: { bannerText: 'Deployment banner' } }));
    await seed(page, 3);
    await expect(page.locator('#page-footer')).toBeVisible();
    await fits(page);
    const height = (await page.locator('#map').boundingBox())!.height;
    await openFilters(page); await openTimeline(page);
    await fits(page);
    expect((await page.locator('#map').boundingBox())!.height).toBeLessThan(height);
    await page.locator('#toggleFilters').click(); await page.locator('#toggleTimeline').click();
    await fits(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await fits(page);
    await navigate(page, 'configuration'); await navigate(page, 'analysis');
    await page.evaluate(() => window.scrollTo(0, 0));
    await fits(page);
    await page.locator('#enlargeMap').click();
    await expect(page.locator('.map-dialog #mapLegend')).toBeVisible();
    await expect.poll(() => page.locator('#map').evaluate(el => el.clientHeight)).toBeGreaterThan(400);
    await page.keyboard.press('Escape');
    await fits(page);
});

test('empty legend gives its space to the map', async ({ page }) => {
    await seed(page, 0);
    await expect(page.locator('#mapLegend')).toBeHidden();
    expect(await page.locator('#map').evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('workspaceDock')!.getBoundingClientRect().top - 10)).toBe(true);
});
