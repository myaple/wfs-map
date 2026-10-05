import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';

test('compact comparison card keeps the plot prominent and controls accessible', async ({ page }) => {
    await page.addInitScript(config => { localStorage.setItem('wfs-theme', 'dark'); localStorage.setItem('wfs-settings', JSON.stringify({
        sources: ['Test WFS', 'Test WFS 2'].map((name, i) => ({ id: `source-${i}`, name, enabled: true,
            config: { ...config, url: '/wfs?points=1024', layer: 'demo:points' } }))
    })); }, defaultConfig);
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && s.workspace.results.length === 3));
    const id = await page.locator('.chart-card').nth(2).getAttribute('data-chart-id');
    const chart = page.locator(`.chart-card[data-chart-id="${id}"]`);
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    await chart.getByLabel('X attribute', { exact: true }).selectOption('category');
    await chart.getByLabel('Y attribute', { exact: true }).selectOption('value');
    await chart.getByRole('button', { name: '+ Add source', exact: true }).click();
    await chart.getByLabel('Source 2 Y attribute', { exact: true }).selectOption('value');
    await expect(chart.locator(':scope > .hint')).toContainText('2,048 plotted');
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    // Match the supplied screenshot's card width, then check a narrow viewport.
    await page.addStyleTag({ content: '#charts { grid-template-columns: 395px; }' });
    await chart.scrollIntoViewIfNeeded();
    const card = (await chart.boundingBox())!, header = (await chart.locator('.chart-header').boundingBox())!;
    const canvas = chart.locator('canvas'), plot = JSON.parse((await canvas.getAttribute('data-plot-rect'))!);
    expect(card.height).toBeLessThan(350);
    expect(header.height).toBeLessThan(45);
    expect(plot.bottom - plot.top).toBeGreaterThanOrEqual(170);
    await expect(chart.getByLabel('Chart source legend')).toContainText('Test WFS 2');
    await expect(chart.locator('.chart-help')).toBeHidden();
    await chart.screenshot({ path: 'test-results/compact-comparison.png' });
    await chart.locator('summary').click();
    await expect(chart.locator('.chart-help')).toContainText('Left-drag to zoom');
    await chart.locator('summary').click();
    await chart.getByRole('button', { name: 'Enlarge', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await chart.getByRole('button', { name: 'Return to normal size', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 700 });
    await page.addStyleTag({ content: '#charts { grid-template-columns: minmax(0, 1fr); }' });
    await chart.scrollIntoViewIfNeeded();
    expect(await chart.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    for (const name of ['Fit data', 'Settings', 'Enlarge', 'Remove chart']) {
        await expect(chart.getByRole('button', { name, exact: true })).toBeVisible();
    }
});
