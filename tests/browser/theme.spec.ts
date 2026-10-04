import { test, expect } from '@playwright/test';

test('theme follows system, persists across pages and redraws map/charts without resetting data', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?time=all&points=64&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.metrics.analysisCharts);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#cancel')).toHaveCSS('background-color', 'rgb(26, 38, 50)');
    await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => {
        const h = (window as any).__WFS_MAP__; (window as any).__themeMap = h.map;
        h.map.jumpTo({ center: [-1, 54], zoom: 8 });
        h.filter([{ field: 'id', op: 'eq', value: '5' }]);
    });
    await expect(page.locator('#filterStatus')).toContainText('1 matches');
    const before = await page.locator('.chart-card canvas').first().evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.locator('.chart-card canvas').first().evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(before);
    expect(await page.evaluate(() => {
        const h = (window as any).__WFS_MAP__;
        return { sameMap: h.map === (window as any).__themeMap, loaded: h.sources[0].loaded, selected: h.sources[0].selected, zoom: h.map.getZoom(), background: h.map.getPaintProperty('background', 'background-color') };
    })).toEqual({ sameMap: true, loaded: 64, selected: 1, zoom: 8, background: '#e8eff3' });
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await page.locator('#enlargeMap').click();
    await expect(page.getByRole('dialog', { name: 'Enlarged map' })).toHaveCSS('background-color', 'rgb(26, 38, 50)');
    await page.keyboard.press('Escape');
    await page.locator('#configLink').click();
    await page.getByRole('button', { name: 'Configure WFS source', exact: true }).click();
    await expect(page.locator('#sourceDialog')).toHaveCSS('background-color', 'rgb(26, 38, 50)');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.route('**/api/analyses', route => route.fulfill({ json: [] }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(errors).toEqual([]);
});

test('system changes apply until the user chooses a theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' }); await page.goto('/?local=1');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
