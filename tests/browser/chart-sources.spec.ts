import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page) {
    await page.goto('/?time=all&points=16&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.workspace.results.length === 3);
    await page.locator('#configLink').click(); await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('CSV temperatures'); await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles({ name: 'temperatures.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,day,temperature,station\n-1,54,2026-10-01,7,north\n-2,53,2026-10-02,9,south') });
    await expect(page.locator('#csvFileStatus')).toContainText('5 columns'); await page.locator('#csvTime').selectOption('day');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1]?.workspace.results.length === 3);
    await page.locator('#analysisLink').click();
    return page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.id));
}
test('all charts stay visible and each source selector repopulates axes, aggregation and routes selection', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    const ids = await setup(page);
    await expect(page.locator('.chart-card')).toHaveCount(6);
    const chartId = await page.locator('.chart-card').nth(1).getAttribute('data-chart-id');
    const chart = page.locator(`.chart-card[data-chart-id="${chartId}"]`);
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    await chart.getByRole('button', { name: 'Enlarge', exact: true }).click();
    await chart.getByLabel('Data source', { exact: true }).selectOption(ids[1]);
    await expect(chart).toHaveAttribute('data-source-id', ids[1]);
    await expect(chart.getByLabel('Time attribute', { exact: true }).locator('option')).toHaveText(['day']);
    await chart.getByLabel('Y aggregation', { exact: true }).selectOption('mean');
    await expect(chart.getByLabel('Y attribute', { exact: true }).locator('option')).toHaveText(['lon', 'lat', 'temperature']);
    await chart.getByLabel('Y attribute', { exact: true }).selectOption('temperature');
    await page.waitForFunction(id => (window as any).__WFS_MAP__.sources[1].workspace.results.some((r: any) => r.id === id && r.measure?.includes('temperature')), chartId, { timeout: 10000 });
    await chart.getByRole('button', { name: 'Return to normal size', exact: true }).click();
    await page.locator('#filterSource').selectOption(ids[1]); await page.locator('#filterSource').selectOption(ids[0]);
    await expect(page.locator('.chart-card')).toHaveCount(6);
    await expect(chart.getByLabel('Time attribute', { exact: true })).toHaveValue('day');
    await chart.getByLabel('Chart type').selectOption('bar'); await chart.getByLabel('Group by', { exact: true }).selectOption('station');
    await expect(chart.locator('.hint').last()).toContainText('2 plotted');
    await chart.locator('details').last().locator('summary').click();
    await chart.getByRole('button', { name: /station: north/ }).click();
    await page.locator('#filterSource').selectOption(ids[1]); await page.locator('#apply').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1].selected === 1);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(16);
    await page.locator('#filterSource').selectOption(ids[1]);
    await expect(page.locator('#rules .selection').getByLabel('Attribute')).toHaveValue('station');
    await expect(page.locator('#rules .selection').getByLabel('Filter value')).toHaveValue('north');
    await chart.getByLabel('Data source', { exact: true }).selectOption(ids[0]);
    await expect(chart.getByLabel('Group by', { exact: true }).locator('option')).not.toContainText(['station']);
    await expect(chart).toHaveAttribute('data-source-id', ids[0]);
    expect(errors).toEqual([]);
});
test('disabled and reloaded sources retain visible cards and source removal affects only its charts', async ({ page }) => {
    const ids = await setup(page);
    const csvCards = page.locator(`.chart-card[data-source-id="${ids[1]}"]`);
    await page.locator('#configLink').click(); await page.getByRole('checkbox', { name: 'Enable CSV temperatures', exact: true }).uncheck(); await page.locator('#saveSettings').click(); await page.locator('#analysisLink').click();
    await expect(page.locator('.chart-card')).toHaveCount(6); await expect(csvCards.first()).toContainText('Load this source');
    await expect(page.locator('#filterSource option')).toHaveCount(1);
    await csvCards.first().getByRole('button', { name: 'Settings', exact: true }).click();
    const source = csvCards.first().getByLabel('Data source', { exact: true });
    await expect(source.locator('option')).toHaveText(['Choose an enabled data source', 'WFS source']);
    await expect(source).toHaveValue('');
    await expect(csvCards.first()).toHaveAttribute('data-source-id', ids[1]);
    await page.locator('#configLink').click(); await page.getByRole('checkbox', { name: 'Enable CSV temperatures', exact: true }).check(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1].workspace.results.length === 3);
    await page.locator('#analysisLink').click(); await expect(csvCards.first()).toContainText('2 plotted');
    await page.locator('#configLink').click(); await page.getByRole('button', { name: 'Remove CSV temperatures', exact: true }).click(); await page.locator('#saveSettings').click(); await page.locator('#analysisLink').click();
    await expect(page.locator('.chart-card')).toHaveCount(3); await expect(csvCards).toHaveCount(0);
    await page.locator('.chart-card').first().getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.chart-card').first().getByLabel('Data source', { exact: true }).locator('option')).toHaveCount(1);
});
test('raw observations follow the chosen source and a new schema refreshes the same card', async ({ page }) => {
    const ids = await setup(page);
    const chartId = await page.locator('.chart-card').nth(2).getAttribute('data-chart-id');
    const chart = page.locator(`.chart-card[data-chart-id="${chartId}"]`);
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    await chart.getByLabel('Data source', { exact: true }).selectOption(ids[1]);
    await chart.getByLabel('X attribute', { exact: true }).selectOption('temperature');
    await chart.getByLabel('Y attribute', { exact: true }).selectOption('lat');
    await chart.getByLabel('Binning', { exact: true }).selectOption('exact');
    await page.waitForFunction(id => (window as any).__WFS_MAP__.sources[1].workspace.results.some((r: any) => r.id === id && r.raw?.rows.length === 2), chartId);
    await chart.locator('.raw-scatter canvas:not(.raw-scatter-axes)').press('Enter');
    await page.locator('#filterSource').selectOption(ids[1]); await page.locator('#apply').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1].selected === 1);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(16);
    // Hold the persisted-file read so replacement always races the editor restore,
    // rather than depending on runner speed or IndexedDB scheduling.
    await page.evaluate(() => {
        const original = Blob.prototype.text;
        Blob.prototype.text = function() {
            if (this instanceof File) return original.call(this);
            return new Promise(resolve => {
                (window as any).__resumeCSVRestore = async () => {
                    Blob.prototype.text = original;
                    resolve(await original.call(this));
                };
            });
        };
    });
    await page.locator('#configLink').click(); await page.getByRole('button', { name: 'Configure CSV temperatures', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).__resumeCSVRestore === 'function');
    await expect(page.locator('#csvTime')).toHaveValue('day');
    await expect(page.locator('#longitudeField')).toHaveValue('lon');
    await expect(page.locator('#latitudeField')).toHaveValue('lat');
    await page.locator('#csvFile').setInputFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,day,pressure\n-1,54,2026-10-01,1000\n-2,53,2026-10-02,1002') });
    await expect(page.locator('#csvFileStatus')).toContainText('4 columns');
    await expect(page.locator('#csvTime')).toHaveValue('day');
    await page.evaluate(() => (window as any).__resumeCSVRestore());
    await expect(page.locator('#csvFileStatus')).toContainText('new.csv · 4 columns');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1].done && (window as any).__WFS_MAP__.sources[1].selected === 2);
    await page.locator('#analysisLink').click(); await expect(page.locator('.chart-card')).toHaveCount(6);
    await expect(chart.getByLabel('X attribute', { exact: true }).locator('option')).toHaveText(['lon', 'lat', 'day', 'pressure']);
    await expect(chart).toHaveAttribute('data-source-id', ids[1]);
    await expect(chart.locator('.hint').last()).toContainText('2 plotted');
});
