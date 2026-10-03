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
    for (const id of ['filterSource', 'colorSource', 'chartSource', 'exportSource']) {
        await expect(page.locator(`#${id} option`)).toHaveText(['First', 'Second']);
    }
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
    await expect(page.locator('#filterSource option[value="c"]')).toHaveCount(0);
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

test('pickers fall back when selected sources are disabled and recover from no enabled sources', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'off', name: 'Disabled first', enabled: false, config: { ...config, url: '/wfs?points=4', layer: 'demo:points' } },
        { id: 'a', name: 'First', enabled: true, config: { ...config, url: '/wfs?points=16', layer: 'demo:points' } },
        { id: 'b', name: 'Second', enabled: true, config: { ...config, url: '/wfs?points=8', layer: 'demo:points' } },
    ] })), defaultConfig);
    await page.goto('/?time=all');
    await expect(page.locator('#addRule')).toBeEnabled();
    const pickers = ['filterSource', 'colorSource', 'chartSource', 'exportSource'];
    for (const id of pickers) {
        await expect(page.locator(`#${id} option`)).toHaveText(['First', 'Second']);
        await expect(page.locator(`#${id}`)).toHaveValue('a');
        await page.locator(`#${id}`).selectOption('b');
    }
    await expect(page.locator('#addRule')).toBeEnabled();
    await page.locator('#addRule').click();
    await page.getByLabel('Attribute', { exact: true }).selectOption('category');
    await page.getByLabel('Filter value', { exact: true }).fill('sensor');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('Second · 2 matches');
    await page.locator('#colorAttribute').selectOption('quality');
    await page.locator('#configLink').click();
    await page.getByRole('checkbox', { name: 'Enable Second', exact: true }).uncheck();
    await page.locator('#saveSettings').click(); await page.locator('#analysisLink').click();
    for (const id of pickers) {
        await expect(page.locator(`#${id} option`)).toHaveText(['First']);
        await expect(page.locator(`#${id}`)).toHaveValue('a');
    }
    await expect(page.locator('#filterOwner')).toContainText('Filters for First');
    await expect(page.getByLabel('Filter value', { exact: true })).toHaveCount(0);
    await page.locator('#configLink').click();
    await page.getByRole('checkbox', { name: 'Enable First', exact: true }).uncheck();
    await page.locator('#saveSettings').click(); await page.locator('#analysisLink').click();
    for (const id of pickers) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
        await expect(page.locator(`#${id} option`)).toHaveText(['No enabled data sources']);
    }
    for (const id of ['addRule', 'apply', 'reset', 'sourceColor', 'colorAttribute', 'addChart', 'exportCSV']) await expect(page.locator(`#${id}`)).toBeDisabled();
    await expect(page.locator('#rules')).toBeEmpty();
    await expect(page.locator('.chart-card')).toHaveCount(6);
    const chartId = await page.locator('.chart-card[data-source-id="a"]').first().getAttribute('data-chart-id');
    const chart = page.locator(`.chart-card[data-chart-id="${chartId}"]`);
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    const chartSource = chart.getByLabel('Data source', { exact: true });
    await expect(chartSource).toBeDisabled();
    await expect(chartSource.locator('option')).toHaveText(['No enabled data sources']);
    await page.locator('#configLink').click();
    await page.getByRole('checkbox', { name: 'Enable Second', exact: true }).check();
    await page.locator('#saveSettings').click(); await page.locator('#analysisLink').click();
    for (const id of pickers) {
        await expect(page.locator(`#${id}`)).toBeEnabled();
        await expect(page.locator(`#${id} option`)).toHaveText(['Second']);
        await expect(page.locator(`#${id}`)).toHaveValue('b');
    }
    await expect(page.locator('#filterStatus')).toContainText('Second · 2 matches');
    await expect(page.getByLabel('Filter value', { exact: true })).toHaveValue('sensor');
    await expect(page.locator('#colorAttribute')).toHaveValue('quality');
    await expect(chartSource).toBeEnabled();
    await expect(chartSource.locator('option')).toHaveText(['Choose an enabled data source', 'Second']);
    // A card whose old source is disabled can still be reassigned explicitly.
    await chartSource.selectOption('b');
    await expect(chart).toHaveAttribute('data-source-id', 'b');
    expect(errors).toEqual([]);
});
