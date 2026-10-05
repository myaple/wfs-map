import { test, expect } from '@playwright/test';
import { feature } from '../../server/demo.ts';
test('loads genuine WFS pages, filters and double-clicks the correct GPU ID',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?time=all&points=1024&autoload=1');
  await page.waitForFunction(()=> (window as any).__WFS_MAP__?.done);
  await expect(page.locator('#status')).toContainText('1,024 points loaded');
  await page.evaluate(()=> (window as any).__WFS_MAP__.filter([{field:'id',op:'eq',value:'48'}]));
  await expect(page.locator('#filterStatus')).toContainText('1 matches');
  await page.locator('#map').scrollIntoViewIfNeeded();
  const f=feature(48);
  const point=await page.evaluate(coords=>{const m=(window as any).__WFS_MAP__.map;const p=m.project(coords);const r=m.getCanvas().getBoundingClientRect();return{x:p.x+r.x,y:p.y+r.y};},f.geometry.coordinates);
  await page.mouse.dblclick(point.x,point.y);
  await expect(page.locator('.metadata')).toContainText('points.48');
  await expect(page.locator('.metadata')).toContainText(f.properties.category);
  await page.evaluate(()=> (window as any).__WFS_MAP__.filter([]));
  await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
  expect(errors).toEqual([]);
});
test('GML path uses schema hints and correct axis order',async({page})=>{
  await page.goto('/?time=all&points=105');
  await page.waitForFunction(()=> (window as any).__WFS_MAP__?.map.loaded());
  await page.locator('#configLink').click();await page.getByRole('button', { name: 'Configure WFS source', exact: true }).click();await page.locator('#wfsCompatibility summary').click();
  await page.locator('#format').fill('application/gml+xml; version=3.2');
  await page.locator('#srs').fill('urn:ogc:def:crs:EPSG::4326');
  await page.locator('#axis').selectOption('yx');await page.locator('#pageSize').fill('100');
  await page.locator('#updateSource').click();await page.locator('#saveSettings').click();await page.locator('#load').click();await page.waitForFunction(()=> (window as any).__WFS_MAP__.done);
  await expect(page.locator('#status')).toContainText('105 points loaded');
  await page.evaluate(()=> (window as any).__WFS_MAP__.filter([{field:'id',op:'gte',value:'100'}]));
  await expect(page.locator('#filterStatus')).toContainText('5 matches');
});
test('client limit is explicitly reported and clear releases the dataset',async({page})=>{
  await page.goto('/?time=all&points=1024');await page.waitForFunction(()=> (window as any).__WFS_MAP__?.map.loaded());
  await page.locator('#configLink').click();await page.getByRole('button', { name: 'Configure WFS source', exact: true }).click();await page.locator('#wfsCompatibility summary').click();await page.locator('#limit').fill('100');await page.locator('#updateSource').click();await page.locator('#saveSettings').click();await page.locator('#load').click();
  await page.waitForFunction(()=> (window as any).__WFS_MAP__.done);
  await expect(page.locator('#status')).toContainText('LIMIT REACHED');
  await page.locator('#cancel').click();await expect(page.locator('#hud')).toContainText('Loaded 0');
  await expect(page.locator('#apply')).toBeDisabled();
});
test('high zoom culling retains original IDs and coordinates',async({page})=>{
  await page.goto('/?time=all&points=2048&autoload=1');await page.waitForFunction(()=> (window as any).__WFS_MAP__?.done);
  const f=feature(42);
  await page.evaluate(coords=>(window as any).__WFS_MAP__.map.jumpTo({center:coords,zoom:20}),f.geometry.coordinates);
  await page.waitForFunction(()=>{const n=(window as any).__WFS_MAP__.layer.drawnLastFrame;return n>0&&n<2048;});
  await page.locator('#map').scrollIntoViewIfNeeded();
  const point=await page.evaluate(coords=>{const m=(window as any).__WFS_MAP__.map,p=m.project(coords),r=m.getCanvas().getBoundingClientRect();return {x:p.x+r.x,y:p.y+r.y};},f.geometry.coordinates);
  await page.mouse.dblclick(point.x,point.y);await expect(page.locator('.metadata')).toContainText('points.42');
});

test('map enlargement preserves the live map, data and view, resizes on narrow screens, and restores with button or Escape', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?time=all&points=1024&autoload=1');
  await page.waitForFunction(() => (window as any).__WFS_MAP__?.metrics.analysisCharts);
  await page.evaluate(() => {
    const h = (window as any).__WFS_MAP__;
    (window as any).__originalMap = h.map;
    (window as any).__originalCanvas = h.map.getCanvas();
    h.filter([{ field: 'id', op: 'eq', value: '48' }]);
  });
  await expect(page.locator('#filterStatus')).toContainText('1 matches');
  await expect(page.locator('#hud')).toHaveText('Loaded 1,024 points');
  const f = feature(48);
  await page.evaluate(c => (window as any).__WFS_MAP__.map.jumpTo({ center: c, zoom: 12 }), f.geometry.coordinates);
  const original = (await page.locator('#map').boundingBox())!;
  const requests: string[] = [];
  page.on('request', r => { if (new URL(r.url()).searchParams.get('request') === 'GetFeature') requests.push(r.url()); });
  await page.getByRole('button', { name: 'Enlarge map', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Enlarged map', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#enlargeMap')).toHaveAttribute('aria-expanded', 'true');
  const enlarged = (await page.locator('#map').boundingBox())!;
  expect(enlarged.width).toBeGreaterThan(original.width);
  expect(enlarged.height).toBeGreaterThan(original.height);
  expect(await page.evaluate(() => {
    const h = (window as any).__WFS_MAP__;
    return { sameMap: h.map === (window as any).__originalMap, sameCanvas: h.map.getCanvas() === (window as any).__originalCanvas, loaded: h.sources[0].loaded, selected: h.sources[0].selected, zoom: h.map.getZoom() };
  })).toEqual({ sameMap: true, sameCanvas: true, loaded: 1024, selected: 1, zoom: 12 });
  const point = await page.evaluate(c => { const m = (window as any).__WFS_MAP__.map, p = m.project(c), r = m.getCanvas().getBoundingClientRect(); return { x: p.x + r.x, y: p.y + r.y }; }, f.geometry.coordinates);
  await page.mouse.dblclick(point.x, point.y);
  await expect(dialog.locator('.metadata')).toContainText('points.48');
  await page.getByRole('button', { name: 'Return map to normal size', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#enlargeMap')).toBeFocused();
  await expect(page.locator('#enlargeMap')).toHaveAttribute('aria-expanded', 'false');
  expect((await page.locator('#map').boundingBox())!.width).toBe(original.width);
  await page.locator('#enlargeMap').click();
  await page.setViewportSize({ width: 375, height: 700 });
  await expect.poll(() => page.locator('#map canvas').evaluate(canvas => {
    const r = canvas.getBoundingClientRect(), map = document.getElementById('map')!.getBoundingClientRect();
    // The visible timeline can leave a fractional CSS pixel for the canvas;
    // MapLibre rounds backing dimensions to whole pixels.
    return Math.abs(r.width - map.width) < 1 && Math.abs(r.height - map.height) < 1;
  })).toBe(true);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#enlargeMap')).toBeFocused();
  await expect(page.locator('#hud')).toHaveText('Loaded 1,024 points');
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test('enlarged map right-drag still bounds WFS requests and retains its area after restoration', async ({ page }) => {
  await page.goto('/?time=all&points=1024&autoload=1');
  await page.waitForFunction(() => (window as any).__WFS_MAP__?.metrics.analysisCharts);
  await page.locator('#enlargeMap').click();
  const b = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.move(b.x + b.width * .3, b.y + b.height * .3);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(b.x + b.width * .7, b.y + b.height * .7, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => {
    const h = (window as any).__WFS_MAP__;
    return h.queryBounds.bbox && h.sources[0].done && !h.sources[0].loading;
  });
  const bounds = await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox);
  const expected = Array.from({ length: 1024 }, (_, i) => feature(i)).filter(f => {
    const [x, y] = f.geometry.coordinates;
    return x >= bounds.west && x <= bounds.east && y >= bounds.south && y <= bounds.north;
  }).length;
  expect(expected).toBeGreaterThan(0); expect(expected).toBeLessThan(1024);
  await expect(page.locator('#hud')).toHaveText(`Loaded ${expected.toLocaleString()} points`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#clearArea')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.bbox)).toEqual(bounds);
});
