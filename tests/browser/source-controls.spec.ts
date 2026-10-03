import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';

test('analysis automatically loads enabled sources and scopes filters, colours and chart creation independently', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(config => {
        localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
            { id: 'a', name: 'First', enabled: true, config: { ...config, url: '/wfs?points=64', layer: 'demo:points' } },
            { id: 'b', name: 'Second', enabled: true, config: { ...config, url: '/wfs?points=32', layer: 'demo:points' } },
            { id: 'c', name: 'Disabled', enabled: false, config: { ...config, url: '/wfs?points=8', layer: 'demo:points' } },
        ], background: { enabled: false, url: '', attribution: '' } }));
    }, defaultConfig);
    await page.goto('/?time=all');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.slice(0, 2).every((s: any) => s.done && s.workspace.results.length === 3));
    await expect(page.locator('#analysisSource')).toHaveCount(0);
    await expect(page.locator('#hud')).toHaveText('Loaded 96 points');
    await page.locator('#filterSource').selectOption('b');
    await expect(page.locator('#filterOwner')).toContainText('Filters for Second');
    await expect(page.locator('#rules')).toHaveAttribute('aria-label', 'Filters for Second');
    await expect(page.locator('#colorSource')).toHaveValue('a');
    await expect(page.locator('#chartSource')).toHaveValue('a');
    await page.locator('#addRule').click();
    await page.getByLabel('Attribute', { exact: true }).selectOption('category');
    await page.getByLabel('Filter value', { exact: true }).fill('sensor');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('Second · 8 matches');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(64);
    await page.locator('#colorAttribute').selectOption('quality');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0].layer.colorCodes?.length === 64);
    await page.locator('#colorSource').selectOption('b');
    await page.locator('#sourceColor').fill('#00ff00');
    await page.locator('#colorAttribute').selectOption('value');
    await page.locator('#colorBins').selectOption('8');
    await page.waitForFunction(() => new Set((window as any).__WFS_MAP__.sources[1].layer.colorCodes).size === 8);
    await expect(page.locator('#filterSource')).toHaveValue('b');
    await page.locator('#filterSource').selectOption('a');
    await expect(page.locator('#colorSource')).toHaveValue('b');
    await expect(page.locator('#colorAttribute')).toHaveValue('value');
    await page.locator('#chartSource').selectOption('b'); await page.locator('#addChart').click();
    await expect(page.locator('.chart-card[data-source-id="b"]')).toHaveCount(4);
    await expect(page.locator('.chart-card[data-source-id="a"]')).toHaveCount(3);
    await page.locator('#filterSource').selectOption('b');
    await expect(page.getByLabel('Filter value', { exact: true })).toHaveValue('sensor');
    await page.locator('#reset').click(); await expect(page.locator('#filterStatus')).toContainText('Second · 32 matches');
    await page.locator('#filterSource').selectOption('c');
    await expect(page.locator('#addRule')).toBeDisabled();
    await expect(page.locator('#filterOwner')).toContainText('source disabled');
    await page.locator('#colorSource').selectOption('a');
    await expect(page.locator('#colorAttribute')).toHaveValue('quality');
    // Preferences also survive saving data-source configuration.
    await page.locator('#configLink').click();
    await page.getByRole('button', { name: 'Configure First', exact: true }).click();
    await page.locator('#sourceName').fill('First renamed'); await page.locator('#updateSource').click();
    await page.locator('#saveSettings').click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!).sources);
    expect(saved[0].coloring.field).toBe('quality'); expect(saved[1].coloring.field).toBe('value');
    expect(saved[1].coloring.bins).toBe(8); expect(saved[1].color).toEqual([0, 1, 0]);
    // Re-entering analysis loads cleared enabled sources without a Load click.
    await page.locator('#cancel').click(); await page.locator('#analysisLink').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.slice(0, 2).every((s: any) => s.done && s.layer.colorCodes));
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[2].worker)).toBeUndefined();
    expect(errors).toEqual([]);
});
