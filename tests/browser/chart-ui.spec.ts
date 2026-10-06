import { test, expect } from '@playwright/test';
import { navigate } from '../navigation.ts';

test('chart deletion requires confirmation in normal and enlarged mode; map uses arrow icons', async ({ page }) => {
    await page.goto('/?time=all&points=16&autoload=1');
    const cards = page.locator('.chart-card'); await expect(cards).toHaveCount(3);
    const id = await cards.first().getAttribute('data-chart-id');
    const chart = page.locator(`.chart-card[data-chart-id="${id}"]`);
    page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); });
    await chart.getByRole('button', { name: 'Remove chart', exact: true }).click(); await expect(cards).toHaveCount(3);
    await chart.getByRole('button', { name: 'Enlarge', exact: true }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await chart.getByRole('button', { name: 'Remove chart', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Enlarged attribute chart' })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await chart.getByRole('button', { name: 'Remove chart', exact: true }).click(); await expect(cards).toHaveCount(2);
    await expect(page.locator('#enlargeMap')).toHaveText('⤢');
    await page.locator('#enlargeMap').click(); await expect(page.locator('#enlargeMap')).toHaveText('⤡');
    await page.locator('#enlargeMap').click(); await expect(page.locator('#enlargeMap')).toHaveText('⤢');
});

test('scatter size changes rendered binned and GPU points and local save restores chart settings', async ({ page }) => {
    await page.goto('/?time=all&points=16&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.workspace.results.length === 3);
    const scatter = page.locator('.chart-card').nth(2);
    await scatter.getByRole('button', { name: 'Settings', exact: true }).click();
    const slider = scatter.getByLabel('Point size', { exact: true });
    const before = await scatter.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await slider.fill('8');
    const after = await scatter.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    expect(after).not.toBe(before);
    await scatter.getByLabel('Binning', { exact: true }).selectOption('exact');
    await expect(scatter.locator('.raw-scatter')).toBeVisible();
    const canvas = scatter.locator('.raw-scatter canvas:not(.raw-scatter-axes)');
    const pixels = async () => canvas.evaluate((c: HTMLCanvasElement) => {
        const gl = c.getContext('webgl2')!, bytes = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        let count = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) count++;
        return count;
    });
    const large = await pixels(); await slider.fill('2'); expect(await pixels()).toBeLessThan(large / 2);
    await slider.fill('6');
    await page.locator('#dockSaveAnalysis').click(); await expect(page.locator('#dockSaveAnalysis')).toBeDisabled();
    await page.reload(); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
    await scatter.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(slider).toHaveValue('6');
    await expect(canvas).toBeVisible();
    await navigate(page, 'records'); await expect(page.locator('#dockSaveAnalysis')).toBeVisible();
    await navigate(page, 'derived'); await expect(page.locator('#dockSaveAnalysis')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 900 });
    const box = await page.locator('#dockSaveAnalysis').boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(375);

});
