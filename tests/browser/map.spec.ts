import { test, expect } from '@playwright/test';
import { feature } from '../../server/demo.ts';
test('loads genuine WFS pages, filters and double-clicks the correct GPU ID',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?points=1024&autoload=1');
  await page.waitForFunction(()=> (window as any).__WFS_MAP__?.done);
  await expect(page.locator('#status')).toContainText('1,024 points loaded');
  await page.evaluate(()=> (window as any).__WFS_MAP__.filter([{field:'id',op:'eq',value:'48'}]));
  await expect(page.locator('#filterStatus')).toContainText('1 matches');
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
  await page.goto('/?points=105');
  await page.waitForFunction(()=> (window as any).__WFS_MAP__?.map.loaded());
  await page.locator('aside summary').click();
  await page.locator('#format').fill('application/gml+xml; version=3.2');
  await page.locator('#srs').fill('urn:ogc:def:crs:EPSG::4326');
  await page.locator('#axis').selectOption('yx');await page.locator('#pageSize').fill('100');
  await page.locator('#load').click();await page.waitForFunction(()=> (window as any).__WFS_MAP__.done);
  await expect(page.locator('#status')).toContainText('105 points loaded');
  await page.evaluate(()=> (window as any).__WFS_MAP__.filter([{field:'id',op:'gte',value:'100'}]));
  await expect(page.locator('#filterStatus')).toContainText('5 matches');
});
test('client limit is explicitly reported and clear releases the dataset',async({page})=>{
  await page.goto('/?points=1024');await page.waitForFunction(()=> (window as any).__WFS_MAP__?.map.loaded());
  await page.locator('aside summary').click();await page.locator('#limit').fill('100');await page.locator('#load').click();
  await page.waitForFunction(()=> (window as any).__WFS_MAP__.done);
  await expect(page.locator('#status')).toContainText('LIMIT REACHED');
  await page.locator('#cancel').click();await expect(page.locator('#hud')).toContainText('Loaded 0');
  await expect(page.locator('#apply')).toBeDisabled();
});
test('high zoom culling retains original IDs and coordinates',async({page})=>{
  await page.goto('/?points=2048&autoload=1');await page.waitForFunction(()=> (window as any).__WFS_MAP__?.done);
  const f=feature(42);
  await page.evaluate(coords=>(window as any).__WFS_MAP__.map.jumpTo({center:coords,zoom:20}),f.geometry.coordinates);
  await page.waitForFunction(()=>{const n=(window as any).__WFS_MAP__.layer.drawnLastFrame;return n>0&&n<2048;});
  const point=await page.evaluate(coords=>{const m=(window as any).__WFS_MAP__.map,p=m.project(coords),r=m.getCanvas().getBoundingClientRect();return {x:p.x+r.x,y:p.y+r.y};},f.geometry.coordinates);
  await page.mouse.dblclick(point.x,point.y);await expect(page.locator('.metadata')).toContainText('points.42');
});
