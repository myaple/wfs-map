import { navigate } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';

async function openAt(page: Page, x: number, y: number) {
    const point = await page.evaluate(async ({ x, y }) => {
        const map = (window as any).__WFS_MAP__.map;
        const rendered = new Promise<void>(resolve => map.once('idle', () => resolve()));
        map.jumpTo({ center: [-1, 54], zoom: 8 });
        const r = map.getContainer().getBoundingClientRect();
        const left = Math.max(0, -r.left), top = Math.max(0, -r.top);
        const width = Math.min(r.width, innerWidth - r.left) - left;
        const height = Math.min(r.height, innerHeight - r.top) - top;
        const px = left + width * x, py = top + height * y;
        map.panBy([r.width / 2 - px, r.height / 2 - py], { duration: 0 });
        await rendered;
        const p = map.project([-1, 54]), bounds = map.getContainer().getBoundingClientRect();
        return { x: bounds.left + p.x, y: bounds.top + p.y };
    }, { x, y });
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.map.isMoving());
    await page.mouse.dblclick(point.x, point.y);
    await expect(page.getByRole('region', { name: 'Point metadata' })).toContainText('last_field');
}

async function expectContained(page: Page) {
    await expect.poll(() => page.locator('.metadata-popup').evaluate(popup => {
        const p = popup.getBoundingClientRect(), m = document.getElementById('map')!.getBoundingClientRect();
        const close = popup.querySelector('.maplibregl-popup-close-button')!.getBoundingClientRect();
        const metadata = popup.querySelector('.metadata')!;
        return p.left >= Math.max(m.left, 0) && p.right <= Math.min(m.right, innerWidth)
            && p.top >= Math.max(m.top, 0) && p.bottom <= Math.min(m.bottom, innerHeight)
            && close.top >= p.top && close.bottom <= p.bottom
            && metadata.scrollWidth <= metadata.clientWidth;
    })).toBe(true);
}

test('double-click metadata stays visible and scrolls at map edges, on resize and in the enlarged map', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?time=all#configuration');
    await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('Many fields');
    await page.locator('#type').selectOption('csv');
    const fields = Array.from({ length: 35 }, (_, i) => `field_${i}`);
    const csv = ['lon', 'lat', ...fields, 'long_value', 'last_field'].join(',') + '\n'
        + ['-1', '54', ...fields.map(f => `Metadata for ${f}`), 'x'.repeat(1000), 'End of metadata'].join(',');
    await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'metadata.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    await navigate(page, 'analysis');
    await page.locator('#map').scrollIntoViewIfNeeded();
    await openAt(page, .5, .5);
    await expectContained(page);
    const metadata = page.getByRole('region', { name: 'Point metadata' });
    expect(await metadata.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const view = await page.evaluate(() => {
        const m = (window as any).__WFS_MAP__.map;
        return { center: m.getCenter().toArray(), zoom: m.getZoom() };
    });
    await metadata.hover(); await page.mouse.wheel(0, 300);
    await expect.poll(() => metadata.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await metadata.focus(); await page.keyboard.press('Control+End');
    await expect.poll(() => metadata.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);
    await expect(metadata.getByText('End of metadata', { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => {
        const m = (window as any).__WFS_MAP__.map;
        return { center: m.getCenter().toArray(), zoom: m.getZoom() };
    })).toEqual(view);
    for (const [x, y] of [[.05, .05], [.9, .05], [.05, .9], [.9, .9]]) {
        await page.getByRole('button', { name: 'Close popup' }).click();
        await openAt(page, x, y); await expectContained(page);
    }
    await page.setViewportSize({ width: 375, height: 700 });
    await page.locator('#map').scrollIntoViewIfNeeded();
    await expectContained(page);
    await page.locator('#enlargeMap').click(); await expectContained(page);
    await page.keyboard.press('Escape'); await expectContained(page);
    await page.getByRole('button', { name: 'Close popup' }).click();
    await expect(metadata).toHaveCount(0);
    expect(errors).toEqual([]);
});
