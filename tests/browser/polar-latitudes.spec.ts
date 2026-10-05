import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { defaultConfig } from '../../src/source-settings.ts';
import { parseCSV } from '../../src/csv.ts';

for (const type of ['csv', 'wfs']) test(`${type} polar points load with a warning, fit safely and export original coordinates`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ config, type }) => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'polar', name: 'Polar points', enabled: true, config: { ...config, type,
            url: '/wfs?points=4', layer: 'demo:points', pageSize: '2',
            longitudeField: 'lon', latitudeField: 'lat', timeField: type === 'csv' ? 'observed' : '',
            csvText: 'lon,lat,observed\n10,90,2026-10-01\n20,-90,2026-10-02\n30,86,2026-10-03\n40,54,2026-10-04' } },
    ] })), { config: defaultConfig, type });
    if (type === 'wfs') await page.route('**/wfs?*', async route => {
        const response = await route.fetch();
        const text = await response.text();
        if (!text.trimStart().startsWith('{')) { await route.fulfill({ response }); return; }
        const data = JSON.parse(text);
        const offset = Number(new URL(route.request().url()).searchParams.get('startIndex'));
        data.features.forEach((f: any, i: number) => f.geometry.coordinates = [10 + (offset + i) * 10, [90, -90, 86, 54][offset + i]]);
        await route.fulfill({ response, json: data });
    });
    await page.goto('/?time=all');
    await expect(page.locator('#exportCSV')).toBeEnabled();
    await expect(page.locator('#hud')).toHaveText('Loaded 4 points');
    await expect(page.locator('#status')).toContainText('Warning: 3 points');
    await expect(page.locator('#status')).toContainText('clamped to ±85.051129°');
    await expect(page.locator('#status')).not.toContainText('Load failed');
    const positions = await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].layer.chunks.flatMap((c: any) => Array.from(c.positions)));
    expect(positions[1]).toBe(0); expect(positions[5]).toBe(1); expect(positions[9]).toBe(0);
    await page.locator('#fit').click();
    expect(await page.evaluate(() => Number.isFinite((window as any).__WFS_MAP__.map.getZoom()))).toBe(true);
    await page.evaluate(() => (window as any).__WFS_MAP__.getPoint(0));
    await expect(page.locator('.metadata')).toContainText('90');
    const markerLatitude = await page.evaluate(() => (window as any).__WFS_MAP__.map.getCenter().lat);
    expect(Math.abs(markerLatitude)).toBeLessThanOrEqual(85.051129);
    const pending = page.waitForEvent('download');
    await page.locator('#exportCSV').click();
    const file = await pending;
    const csv = parseCSV(await readFile((await file.path())!, 'utf8'));
    expect(csv.rows.map(r => r[2])).toEqual(['90', '-90', '86', '54']);
    // A local filter must preserve the load warning.
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('polar', []));
    await expect(page.locator('#status')).toContainText('Warning: 3 points');
    expect(errors).toEqual([]);
});
