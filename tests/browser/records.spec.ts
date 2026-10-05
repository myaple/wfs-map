import { navigate } from '../navigation.ts';
import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { readFile } from 'node:fs/promises';
import { parseCSV } from '../../src/csv.ts';

test('Records shares filters and timeline with Analysis, composes table search and exports, and keeps drafts across tabs', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
  { id: 'csv', name: 'Timed CSV', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: 'day', csvText: 'lon,lat,day,label,value\n-1,54,2025-01-01,a,1\n-2,53,2025-01-02,b,2\n-3,52,2025-01-03,b,3\n-4,51,,b,4' } },
  { id: 'wfs', name: 'WFS', enabled: true, config: { ...config, url: '/wfs?points=32', layer: 'demo:points' } },
 ] })), defaultConfig);
 await page.goto('/?time=all#records');
 await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
 const status = page.locator('#records > [role=status]');
 await expect(status).toContainText('4 table rows');
 await expect(page.locator('#recordsFilters')).not.toHaveAttribute('open', '');
 await page.locator('#recordsFilters > summary').click();
 await expect(page.locator('#records .query-panel')).toBeVisible();
 await expect(page.locator('#records .filter-panel')).toBeVisible();
 await expect(page.locator('#records > .timeline')).toBeVisible();
 await expect(page.locator('#filterSource')).toHaveValue('csv');
 let requests = 0; page.on('request', r => { if (/GetFeature|DescribeFeatureType/i.test(r.url())) requests++; });
 await page.locator('#rules > .filter-group > .group-head').getByRole('button', { name: '+ Rule', exact: true }).click();
 const rule = page.locator('#rules .rule');
 await rule.getByLabel('Attribute', { exact: true }).selectOption('value');
 await rule.getByLabel('Operator', { exact: true }).selectOption('gte');
 await rule.getByLabel('Filter value', { exact: true }).fill('2');
 await expect(status).toContainText('4 table rows');
 await page.locator('#apply').click(); await expect(status).toContainText('3 table rows');
 await page.getByLabel('Timeline start (UTC)', { exact: true }).fill('2025-01-02');
 await page.getByLabel('Timeline end (UTC)', { exact: true }).fill('2025-01-03');
 await page.getByRole('button', { name: 'Set window', exact: true }).click();
 await expect(status).toContainText('2 table rows');
 await page.getByLabel('Search applied records').fill('2025-01-03'); await expect(status).toContainText('1 table rows');
 const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download table CSV' }).click();
 const csv = parseCSV(await readFile((await (await download).path())!, 'utf8'));
 expect(csv.rows).toHaveLength(1); expect(csv.rows[0][csv.headers.indexOf('value')]).toBe('3');
 await page.getByLabel('Search applied records').fill(''); await expect(status).toContainText('2 table rows');
 await rule.getByLabel('Filter value', { exact: true }).fill('3');
 await page.getByRole('button', { name: 'Collapse filter group', exact: true }).click();
 await navigate(page, 'analysis');
 await expect(page.locator('#analysis > .timeline')).toBeVisible();
 await expect(page.locator('#analysis .filter-panel')).toBeVisible();
 await expect(rule.getByLabel('Filter value', { exact: true })).toHaveValue('3');
 await expect(page.getByRole('button', { name: 'Expand filter group', exact: true })).toBeVisible();
 await expect(page.getByLabel('Use time window')).toBeChecked();
 expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(2);
 await navigate(page, 'records'); await expect(status).toContainText('2 table rows');
 await page.getByRole('button', { name: 'Expand filter group', exact: true }).click();
 await page.locator('#apply').click(); await expect(status).toContainText('1 table rows');
 await page.getByRole('slider', { name: 'Move time window', exact: true }).focus(); await page.keyboard.press('End');
 await expect(status).toContainText('0 table rows');
 await page.getByRole('button', { name: 'Show all loaded times', exact: true }).click(); await expect(status).toContainText('2 table rows');
 await page.locator('#recordsSource').selectOption('wfs'); await expect(page.locator('#filterSource')).toHaveValue('wfs');
 await page.locator('#recordsSource').selectOption('csv'); await expect(page.locator('#filterSource')).toHaveValue('csv');
 await expect(rule.getByLabel('Filter value', { exact: true })).toHaveValue('3');
 await navigate(page, 'configuration'); await expect(page.locator('.timeline')).toBeHidden();
 await navigate(page, 'records');
 await page.setViewportSize({ width: 375, height: 700 });
 for (const selector of ['#records > .timeline', '#records .filter-panel', '#records .query-panel']) {
  expect(await page.locator(selector).evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && e.scrollWidth <= e.clientWidth; })).toBe(true);
 }
 await page.locator('#reset').click(); await expect(status).toContainText('4 table rows');
 await expect(page.locator('.timeline')).toHaveCount(1); await expect(page.locator('#filterSource')).toHaveCount(1);
 expect(requests).toBe(0); expect(errors).toEqual([]);
});

test('Records is a third page, virtualizes applied results, searches, sorts, exports and inspects without filtering', async ({page})=>{
 const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(config=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'a',name:'First',enabled:true,config:{...config,url:'/wfs?points=10000',layer:'demo:points'}},{id:'b',name:'Second',enabled:true,config:{...config,url:'/wfs?points=10',layer:'demo:points'}},{id:'c',name:'Disabled',enabled:false,config}]})),defaultConfig);
 await page.goto('/?time=all#records');
 await expect(page.locator('#records')).toBeVisible(); await expect(page.locator('#analysis')).toBeHidden();
 await expect(page.locator('#recordsSource option')).toHaveText(['First','Second']);
 await expect(page.locator('#records > [role=status]')).toContainText('10,000 table rows');
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
 await page.getByLabel('Search applied records').fill('sensor'); await expect(page.locator('#records > [role=status]')).toContainText('2,500 table rows');
 await page.getByRole('button',{name:'quality (number)',exact:true}).click();
 await page.locator('.records-scroll').focus(); await page.keyboard.press('End');
 await expect.poll(()=>page.locator('.record-row').first().getAttribute('aria-rowindex')).toMatch(/\d+/);
 const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Download table CSV'}).click(); const d=await downloadPromise; expect(d.suggestedFilename()).toBe('records.csv');
 await page.evaluate(()=>(window as any).__WFS_MAP__.chooseRecords([{sourceId:'a',index:0},{sourceId:'b',index:0}]));
 await expect(page.getByRole('dialog',{name:'Choose overlapping record'})).toBeVisible();
 await expect(page.locator('.record-choices')).toContainText('Second');
 await page.locator('.record-choices button').last().click(); await expect(page.locator('.record-inspector')).toContainText('Second');
 await navigate(page, 'analysis'); await expect(page.locator('.record-inspector')).toBeHidden(); await expect(page.locator('#analysis .record-inspector')).toHaveCount(0);
 await navigate(page, 'records'); await expect(page.locator('.record-inspector')).toBeVisible(); await expect(page.locator('.record-inspector')).toContainText('Second'); await navigate(page, 'analysis');
 await page.evaluate(()=>(window as any).__WFS_MAP__.filterSource('a',[{field:'quality',op:'gte',value:'90'}]));
 await navigate(page, 'records'); await page.getByLabel('Search applied records').fill('');
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
 await navigate(page, 'records'); await expect(page.locator('.record-inspector')).toContainText('B'); await expect(page.locator('.record-inspector')).toBeVisible(); await navigate(page, 'analysis');
 await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('a', [{ field: 'value', op: 'gte', value: '2' }])); await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 await pick(); await expect(page.locator('.record-choices button')).toHaveCount(2); expect(await page.locator('.record-choices button').first().getAttribute('data-index')).toBe('1');
});
