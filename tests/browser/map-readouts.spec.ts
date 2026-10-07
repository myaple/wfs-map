import { test, expect } from '@playwright/test';

async function fixture(page: any) {
    await page.addInitScript(() => localStorage.setItem('wfs-settings', JSON.stringify({
        sources: [{ id: 'ellipse', name: 'Harrogate observation', enabled: true, config: {
            type: 'csv', csvText: 'lon,lat,major,minor,angle\n-1.546,53.998,300,100,45',
            longitudeField: 'lon', latitudeField: 'lat', ellipseMajorField: 'major',
            ellipseMinorField: 'minor', ellipseOrientationField: 'angle',
            ellipseMajorUnit: 'm', ellipseMinorUnit: 'm', url: ''
        } }], background: { url: '', attribution: '', enabled: false },
        map: { center: [-1.546, 53.998], zoom: 14, pointSize: 2, ellipses: true, ellipseVertices: 12 }
    })));
    await page.goto('/?time=all');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
}

for (const deviceScaleFactor of [1, 2]) test.describe(`map readouts at DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });
    test('point-size slider changes rendered outline thickness on the GPU', async ({ page }) => {
        await fixture(page);
        await page.evaluate(() => { const l = (window as any).__WFS_MAP__.layer; l.setColors(new Uint8Array(l.count), ['#ff0000', '#ff0000'], 2); });
        const pixelCount = () => page.evaluate(() => new Promise<number>(resolve => {
            const h = (window as any).__WFS_MAP__, gl = h.layer.gl, canvas = h.map.getCanvas();
            h.map.once('render', () => {
                const data = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
                let red = 0;
                for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
                resolve(red);
            }); h.map.triggerRepaint();
        }));
        const thin = await pixelCount();
        expect(thin).toBeGreaterThan(100 * deviceScaleFactor ** 2);
        await page.locator('#size').fill('8');
        const thick = await pixelCount();
        expect(thick / thin).toBeGreaterThan(3.5);
        expect(thick / thin).toBeLessThan(4.5);
        await page.locator('#size').fill('2');
        expect(await pixelCount()).toBe(thin);
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.layer.gl.getError())).toBe(0);
    });
});

test('cursor coordinates, metric scale and point count remain separate in normal and enlarged maps', async ({ page }) => {
    await fixture(page);
    const coordinates = page.getByLabel('Cursor latitude and longitude');
    const scale = page.locator('.maplibregl-ctrl-scale');
    await expect(coordinates).toHaveText('Lat —  Lon —');
    await expect(scale).toContainText(/\d+\s*m$/);
    const hover = async () => {
        const canvas = await page.locator('#map canvas').boundingBox();
        await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
        await expect(coordinates).toHaveText(/^Lat 53\.998\d{2}°  Lon -1\.546\d{2}°$/);
        const boxes = await Promise.all([coordinates, scale, page.locator('#hud')].map(el => el.boundingBox()));
        expect(boxes[0]!.y).toBeGreaterThanOrEqual(boxes[2]!.y + boxes[2]!.height);
        expect(boxes[0]!.x + boxes[0]!.width).toBeLessThan(boxes[1]!.x);
    };
    await hover();
    await page.locator('.map-panel').screenshot({ path: 'docs/screenshots/map-readouts-thin.png' });
    await page.locator('#size').fill('8');
    await hover();
    await page.locator('.map-panel').screenshot({ path: 'docs/screenshots/map-readouts-thick.png' });
    await page.mouse.move(0, 0);
    await expect(coordinates).toHaveText('Lat —  Lon —');
    await page.locator('#enlargeMap').click();
    await hover();
    await page.locator('.map-dialog').screenshot({ path: 'docs/screenshots/map-readouts-enlarged.png' });
    // Camera movement beneath a stationary cursor updates both readouts.
    await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [12.25, -20.5], zoom: 5 }));
    await expect(coordinates).toHaveText(/^Lat -20\.\d{5}°  Lon 12\.\d{5}°$/);
    const values = (await coordinates.textContent())!.match(/-?\d+\.\d+/g)!.map(Number);
    expect(values[0]).toBeCloseTo(-20.5, 1); expect(values[1]).toBeCloseTo(12.25, 1);
    await expect(scale).toContainText(/\d+\s*km$/);
    const firstScale = await scale.textContent();
    await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [12.25, 75] }));
    await expect.poll(() => scale.textContent()).not.toBe(firstScale);
    // Narrow map, theme and attribution must not overlap the corner readouts.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('themechange'));
        const m = (window as any).__WFS_MAP__.map;
        m.addSource('attributed', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Test attribution' });
        m.addLayer({ id: 'attributed', source: 'attributed', type: 'circle' });
        m.jumpTo({ center: [-1.546, 53.998], zoom: 14 });
    });
    await hover();
    await expect(page.locator('.maplibregl-ctrl-attrib')).toBeVisible();
    await page.locator('.map-dialog').screenshot({ path: 'docs/screenshots/map-readouts-mobile-dark.png' });
    await page.locator('#enlargeMap').click();
    await expect(coordinates).toBeVisible(); await expect(scale).toBeVisible();
});
