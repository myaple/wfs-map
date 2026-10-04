import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
test('Records is a third page, virtualizes applied results, searches, sorts, exports and inspects without filtering', async ({page})=>{
 const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(config=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'a',name:'First',enabled:true,config:{...config,url:'/wfs?points=10000',layer:'demo:points'}},{id:'b',name:'Second',enabled:true,config:{...config,url:'/wfs?points=10',layer:'demo:points'}},{id:'c',name:'Disabled',enabled:false,config}]})),defaultConfig);
 await page.goto('/?time=all#records');
 await expect(page.locator('#records')).toBeVisible(); await expect(page.locator('#analysis')).toBeHidden();
 await expect(page.locator('#recordsSource option')).toHaveText(['First','Second']);
 await expect(page.locator('#records [role=status]')).toContainText('10,000 table rows');
 const search = page.getByLabel('Search applied records'), columns = page.locator('.records-columns > summary');
 const height = (await search.boundingBox())!.height;
 await columns.click(); await expect(page.locator('.records-column-options')).toBeVisible();
 expect((await search.boundingBox())!.height).toBe(height);
 await page.locator('.records-column-options').getByLabel('Longitude', {exact:true}).uncheck();
 await expect(page.getByRole('button',{name:'Longitude',exact:true})).toHaveCount(0);
 await columns.focus(); await page.keyboard.press('Escape'); await expect(page.locator('.records-column-options')).toBeHidden();
 expect(await page.locator('.record-row').count()).toBeLessThanOrEqual(40);
 await page.locator('.record-row').first().click(); await expect(page.locator('.record-inspector')).toContainText('ID');
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.sources[0].selected)).toBe(10000);
 await page.getByLabel('Search applied records').fill('sensor'); await expect(page.locator('#records [role=status]')).toContainText('2,500 table rows');
 await page.getByRole('button',{name:'quality (number)',exact:true}).click();
 await page.locator('.records-scroll').focus(); await page.keyboard.press('End');
 await expect.poll(()=>page.locator('.record-row').first().getAttribute('aria-rowindex')).toMatch(/\d+/);
 const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Download table CSV'}).click(); const d=await downloadPromise; expect(d.suggestedFilename()).toBe('records.csv');
 await page.evaluate(()=>(window as any).__WFS_MAP__.chooseRecords([{sourceId:'a',index:0},{sourceId:'b',index:0}]));
 await expect(page.getByRole('dialog',{name:'Choose overlapping record'})).toBeVisible();
 await expect(page.locator('.record-choices')).toContainText('Second');
 await page.locator('.record-choices button').last().click(); await expect(page.locator('.record-inspector')).toContainText('Second');
 await page.locator('#analysisLink').click(); await expect(page.locator('.record-inspector')).toBeHidden(); await expect(page.locator('#analysis .record-inspector')).toHaveCount(0);
 await page.locator('#recordsLink').click(); await expect(page.locator('.record-inspector')).toBeVisible(); await expect(page.locator('.record-inspector')).toContainText('Second'); await page.locator('#analysisLink').click();
 await page.evaluate(()=>(window as any).__WFS_MAP__.filterSource('a',[{field:'quality',op:'gte',value:'90'}]));
 await page.locator('#recordsLink').click(); await page.getByLabel('Search applied records').fill('');
 await expect(page.locator('.record-inspector')).toBeVisible();
 await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 const matches = await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected);
 await expect(page.locator('#records > [role=status]')).toContainText(`${matches.toLocaleString()} table rows`);
 expect(errors).toEqual([]);
});

test('map chooser includes coincident records within and across sources, and excludes filtered-out rows', async ({ page }) => {
 await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
  { id: 'a', name: 'A', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', csvText: 'lon,lat,value\n-1,54,1\n-1,54,2' } },
  { id: 'b', name: 'B', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', csvText: 'lon,lat,value\n-1,54,3' } },
 ] })), defaultConfig);
 await page.goto('/?time=all#analysis'); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
 const pick = async () => {
  await page.locator('#map').scrollIntoViewIfNeeded();
  const point = await page.evaluate(() => { const map = (window as any).__WFS_MAP__.map; map.jumpTo({ center: [-1,54], zoom: 12 }); const p=map.project([-1,54]),r=map.getCanvas().getBoundingClientRect();return {x:r.left+p.x,y:r.top+p.y}; });
  await page.mouse.dblclick(point.x,point.y);
 };
 await pick(); await expect(page.locator('.record-choices button')).toHaveCount(3); await expect(page.locator('.record-choices')).toContainText('B');
 await page.locator('.record-choices button').last().click(); await expect(page.locator('.record-inspector')).toBeHidden();
 await page.locator('#recordsLink').click(); await expect(page.locator('.record-inspector')).toContainText('B'); await expect(page.locator('.record-inspector')).toBeVisible(); await page.locator('#analysisLink').click();
 await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('a', [{ field: 'value', op: 'gte', value: '2' }])); await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 await pick(); await expect(page.locator('.record-choices button')).toHaveCount(2); expect(await page.locator('.record-choices button').first().getAttribute('data-index')).toBe('1');
});
