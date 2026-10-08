import { test, expect, type Page, type Locator } from '@playwright/test';
import { feature } from '../../server/demo.ts';
import { defaultConfig } from '../../src/source-settings.ts';
const ready = async (page: Page) => {
    await page.goto('/?time=all&points=4096&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.workspace.results.length === 3);
    await page.locator('#fit').click();
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.map.isMoving());
};
async function drag(page: Page, canvas: Locator, a: number[], b: number[]) {
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + a[0], box.y + a[1]);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + b[0], box.y + b[1], { steps: 6 });
    await page.mouse.up({ button: 'middle' });
}
async function wholePlot(page: Page, canvas: Locator) {
    const rect = JSON.parse((await canvas.getAttribute('data-plot-rect'))!);
    await drag(page, canvas, [rect.left, rect.top], [rect.right - 1, rect.bottom - 1]);
}
const rows = (page: Page) => page.evaluate(() => Array.from((window as any).__WFS_MAP__.layer.highlighted) as number[]);
const count = (page: Page) => page.evaluate(() => (window as any).__WFS_MAP__.layer.highlighted.length);

test('map brush highlights the same records in every chart, replaces selection, and middle double-click clears only highlights', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await ready(page);
    const map = page.locator('#map canvas.maplibregl-canvas');
    const before = await page.evaluate(() => ({ requests: (window as any).__WFS_MAP__.sources[0].filterRequest, expression: (window as any).__WFS_MAP__.workspace.expression() }));
    const p = await page.evaluate(coords => { const p = (window as any).__WFS_MAP__.map.project(coords); return [p.x, p.y]; }, feature(0).geometry.coordinates);
    await drag(page, map, [p[0] - 20, p[1] - 20], [p[0] + 20, p[1] + 20]);
    expect(await rows(page)).toContain(0);
    const selected = await count(page); expect(selected).toBeGreaterThan(0); expect(selected).toBeLessThan(4096);
    await page.screenshot({ path: 'docs/screenshots/middle-drag-map.png', fullPage: true });
    for (const canvas of await page.locator('.chart-card > .chart-plot > canvas').all()) await expect(canvas).toHaveAttribute('data-highlighted', String(selected));
    // Select a bar bin to verify records propagate back to the map.
    const bar = page.locator('.chart-card').first().locator('canvas');
    await wholePlot(page, bar);
    await expect(map).toHaveAttribute('data-highlighted', '4096');
    expect(await page.evaluate(() => ({ requests: (window as any).__WFS_MAP__.sources[0].filterRequest, expression: (window as any).__WFS_MAP__.workspace.expression() }))).toEqual(before);
    await map.scrollIntoViewIfNeeded();
    await map.click({ button: 'middle', clickCount: 2, position: { x: 140, y: 100 } });
    await expect(map).toHaveAttribute('data-highlighted', '0');
    expect(errors).toEqual([]);
});

test('raw scatter middle brushing is independent of zoom/filtering, renders orange points, and empty brushes replace highlights', async ({ page }) => {
    await ready(page);
    const card = page.locator('.chart-card').nth(2);
    await card.getByRole('button', { name: 'Settings', exact: true }).click();
    await card.getByLabel('Binning', { exact: true }).selectOption('exact');
    await card.getByRole('button', { name: 'Settings', exact: true }).click();
    const canvas = card.locator('.raw-scatter canvas:not(.raw-scatter-axes)');
    await expect(canvas).toHaveAttribute('data-plot-rect');
    const view = await canvas.getAttribute('data-view');
    await wholePlot(page, canvas);
    expect(await count(page)).toBe(4096);
    await expect(canvas).toHaveAttribute('data-highlighted', '4096');
    const orange = await canvas.evaluate(el => {
        const c = el as HTMLCanvasElement, gl = c.getContext('webgl2')!, pixels = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let n = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 255 && Math.abs(pixels[i + 1] - 140) <= 1 && pixels[i + 2] === 0) n++;
        return n;
    });
    expect(orange).toBeGreaterThan(100);
    await expect(canvas).toHaveAttribute('data-view', view!);
    const rect = JSON.parse((await canvas.getAttribute('data-plot-rect'))!);
    await drag(page, canvas, [rect.left + (rect.right - rect.left) * .2, rect.top + (rect.bottom - rect.top) * .2], [rect.left + (rect.right - rect.left) * .5, rect.top + (rect.bottom - rect.top) * .5]);
    await page.screenshot({ path: 'docs/screenshots/middle-drag-scatter.png', fullPage: true });
    const p = JSON.parse((await canvas.getAttribute('data-plot-rect'))!);
    await drag(page, canvas, [p.left + 1, p.top + 1], [p.left + 7, p.top + 7]);
    await expect(canvas).toHaveAttribute('data-highlighted', '0');
    expect(await count(page)).toBe(0);
    await wholePlot(page, canvas);
    await canvas.click({ button: 'middle', clickCount: 2, position: { x: p.left + 20, y: p.top + 20 } });
    await expect(canvas).toHaveAttribute('data-highlighted', '0');
});

test('pie, time and binned scatter highlight records and retain filters in enlarged charts', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => { const w = (window as any).__WFS_MAP__.workspace; w.restore({ op: 'and', children: [{ field: 'active', op: 'eq', value: 'true' }] }, w.specs); (window as any).__WFS_MAP__.filter(); });
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    const selected = await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected);
    for (const index of [1, 2, 0]) {
        const card = page.locator('.chart-card').nth(index);
        if (index === 0) {
            await card.getByRole('button', { name: 'Settings', exact: true }).click();
            await card.getByLabel('Chart type').selectOption('pie');
            await page.waitForFunction(() => (window as any).__WFS_MAP__.workspace.results[0].type === 'pie');
        }
        await card.getByRole('button', { name: 'Enlarge', exact: true }).click();
        const canvas = page.getByRole('dialog').locator('.chart-card canvas');
        if (index === 0) {
            const b = (await canvas.boundingBox())!;
            await drag(page, canvas, [1, 1], [b.width - 1, b.height - 1]);
        } else await wholePlot(page, canvas);
        await expect(canvas).toHaveAttribute('data-highlighted', String(selected));
        expect(await count(page)).toBe(selected);
        await canvas.click({ button: 'middle', clickCount: 2, position: { x: 140, y: 100 } });
        await expect(canvas).toHaveAttribute('data-highlighted', '0');
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(selected);
        await page.keyboard.press('Escape');
    }
});

test('row identities stay scoped to each CSV source in combined charts and reload invalidates selection', async ({ page }) => {
    await page.addInitScript(config => {
        const csv = (offset: number) => 'lon,lat,category,value,quality,timestamp\n' + [0, 1, 2].map(i => `${offset + i},54,group-${i},${offset + i},${i + 1},2026-10-0${i + 1}`).join('\n');
        localStorage.setItem('wfs-settings', JSON.stringify({ sources: ['first', 'second'].map((id, i) => ({ id, name: id, enabled: true, config: { ...config, type: 'csv', csvText: csv(i * 10), longitudeField: 'lon', latitudeField: 'lat', timeField: 'timestamp', limit: '100' } })), background: { enabled: false, url: '', attribution: '' } }));
    }, defaultConfig);
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && s.workspace.results.length === 3));
    await page.locator('#fit').click();
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.map.isMoving());
    const map = page.locator('#map canvas.maplibregl-canvas');
    const p = await page.evaluate(() => { const p = (window as any).__WFS_MAP__.map.project([0, 54]); return [p.x, p.y]; });
    await drag(page, map, [p[0] - 6, p[1] - 6], [p[0] + 6, p[1] + 6]);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => Array.from(s.layer.highlighted)))).toEqual([[0], []]);
    const card = page.locator('.chart-card[data-source-id="first"]').nth(2);
    await card.getByRole('button', { name: 'Settings', exact: true }).click();
    await card.getByLabel('X attribute', { exact: true }).selectOption('value');
    await card.getByLabel('Y attribute', { exact: true }).selectOption('quality');
    await card.getByRole('button', { name: '+ Add source', exact: true }).click();
    await card.getByLabel('Source 2 X attribute', { exact: true }).selectOption('value');
    await card.getByLabel('Source 2 Y attribute', { exact: true }).selectOption('quality');
    await card.getByLabel('Binning', { exact: true }).selectOption('exact');
    const canvas = card.locator('.raw-scatter canvas:not(.raw-scatter-axes)');
    await expect(canvas).toHaveAttribute('data-highlighted', '1');
    await wholePlot(page, canvas);
    await expect(canvas).toHaveAttribute('data-highlighted', '6');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.layer.highlighted.length))).toEqual([3, 3]);
    await page.locator('#cancel').click();
    await expect(map).toHaveAttribute('data-highlighted', '0');
});
