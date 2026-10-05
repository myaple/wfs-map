import { navigate } from '../navigation.ts';
import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { readFile } from 'node:fs/promises';
import { unpackArchive } from '../../src/backup-archive.ts';
import { parseCSV } from '../../src/csv.ts';

async function csvPair(page: any) {
 await page.addInitScript((config: any) => {
  if (localStorage.getItem('join-test-initialized')) return;
  localStorage.setItem('join-test-initialized', 'yes');
  localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
   { id: 'left', name: 'Left input', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: 'day', fieldTypes: '{"uuid":"string"}', csvText: 'lon,lat,uuid,value,day,omit\n-1,54,001,1,2025-01-01,A\n-2,53,002,2,2025-01-02,B\n-3,52,,3,,C' } },
   { id: 'right', name: 'Right input', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', fieldTypes: '{"uuid":"string"}', csvText: 'lon,lat,uuid,value,note\n-8,58,001,10,"comma,quote"""\n-9,59,001,20,second\n-7,57,002,30,third\n-6,56,,40,empty' } },
  ] }));
 }, defaultConfig);
 await page.goto('/?time=all#derived');
 await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
 await page.getByLabel('Left match field', { exact: true }).selectOption('uuid');
 await page.getByLabel('Right match field', { exact: true }).selectOption('uuid');
 await page.getByLabel('New dataset name', { exact: true }).fill('Joined snapshot');
}
const tableStatus = (page: any) => page.locator('#records > [role=status]');

test('joins selected columns, resolves duplicate names, persists independent CSV through refresh/removal/reload and backup', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await csvPair(page);
 await page.getByText('Left columns to include', { exact: true }).click();
 await page.getByLabel('Include left column omit', { exact: true }).uncheck();
 await page.getByText('Right columns to include', { exact: true }).click();
 await page.getByLabel('Include right column uuid', { exact: true }).uncheck();
 await page.getByLabel('Include right record ID', { exact: true }).uncheck();
 await page.getByLabel('Include right geometry coordinates', { exact: true }).uncheck();
 await page.getByRole('button', { name: 'Preview join', exact: true }).click();
 await expect(page.locator('#joinStatus')).toContainText('3 output rows');
 await expect(page.locator('#joinStatus')).toContainText('1 repeated right keys');
 await expect(page.locator('.join-sample')).toContainText('Left input.value (number)');
 await expect(page.locator('.join-sample')).toContainText('Right input.value (number)');
 await expect(page.locator('.join-sample')).not.toContainText('Left input.omit');
 await expect(page.locator('.join-sample')).not.toContainText('Right input.uuid');
 await page.getByRole('button', { name: 'Save joined dataset', exact: true }).click();
 await expect(page.locator('#joinStatus')).toContainText('Saved Joined snapshot · 3 rows');
 await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.length === 3 && (window as any).__WFS_MAP__.sources[2].done && !(window as any).__WFS_MAP__.sources[2].filtering);
 await navigate(page, 'records');
 const derivedId = await page.evaluate(() => (window as any).__WFS_MAP__.sources[2].id);
 const config = await page.evaluate(() => (window as any).__WFS_MAP__.sources[2].config);
 expect(config.type).toBe('csv'); expect(config.csvText).toBe(''); expect(config.csvRef).toBeTruthy(); expect(config.timeField).toBe('Left input.day');
 expect(JSON.parse(config.fieldTypes)['Left input.uuid']).toBe('string');
 await page.locator('#recordsSource').selectOption(derivedId); await expect(tableStatus(page)).toContainText('3 table rows');
 let download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download table CSV' }).click();
 const before = parseCSV(await readFile((await (await download).path())!, 'utf8'));
 expect(before.rows.map(r => r[before.headers.indexOf('Right input.value')])).toEqual(['10', '20', '30']);
 expect(before.rows[0][before.headers.indexOf('Left input.uuid')]).toBe('001');
 expect(before.rows[0][before.headers.indexOf('Right input.note')]).toBe('comma,quote"');
 expect(before.headers).not.toContain('Right input.@id'); expect(before.headers).not.toContain('Right input.@longitude');
 await navigate(page, 'derived');
 await page.setViewportSize({ width: 375, height: 700 });
 expect(await page.locator('#derivedDatasets').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
 await page.setViewportSize({ width: 1440, height: 900 });
 // Refresh both inputs and the derived copy from its own saved blob.
 await page.locator('#load').click(); await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.every((s: any) => s.done && !s.filtering));
 await navigate(page, 'records'); await expect(tableStatus(page)).toContainText('3 table rows');
 await navigate(page, 'configuration');
 await page.getByRole('button', { name: 'Configure Left input', exact: true }).click();
 await page.locator('#csvFile').setInputFiles({ name: 'replacement.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,uuid,value,day,omit\n0,50,replaced,99,2025-01-01,changed') });
 await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
 await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0].done && !(window as any).__WFS_MAP__.sources[0].filtering);
 await page.getByRole('button', { name: 'Remove Left input', exact: true }).click();
 await page.getByRole('button', { name: 'Remove Right input', exact: true }).click(); await page.locator('#saveSettings').click();
 await expect(page.locator('#sourceList')).toContainText('Joined snapshot'); await expect(page.locator('#sourceList .source-row')).toHaveCount(1);
 download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download backup', exact: true }).click();
 const backup = await unpackArchive(new Blob([await readFile((await (await download).path())!)]));
 const manifest = JSON.parse(await backup.get('manifest.json')!.text());
 expect(manifest.settings.sources).toHaveLength(1); expect(parseCSV(await backup.get(manifest.csvFiles[derivedId])!.text()).rows).toHaveLength(3);
 await page.reload(); await navigate(page, 'records'); await expect(tableStatus(page)).toContainText('3 table rows');
 download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download table CSV' }).click();
 const after = parseCSV(await readFile((await (await download).path())!, 'utf8')); expect(after).toEqual(before);
 await navigate(page, 'configuration'); await page.getByRole('button', { name: 'Remove Joined snapshot', exact: true }).click(); await page.locator('#saveSettings').click();
 await page.reload(); await expect(page.locator('#sourceList .source-row')).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('left join, applied input scope, preview invalidation and validation prevent stale or unbounded saves', async ({ page }) => {
 await csvPair(page);
 await page.getByLabel('Join type', { exact: true }).selectOption('left');
 await page.getByRole('button', { name: 'Preview join', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('4 output rows');
 await page.getByLabel('Maximum output rows', { exact: true }).fill('1'); await page.getByLabel('Maximum output rows', { exact: true }).blur();
 await page.getByRole('button', { name: 'Preview join', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('Above Maximum output rows');
 await expect(page.getByRole('button', { name: 'Save joined dataset', exact: true })).toBeDisabled();
 await page.getByLabel('Maximum output rows', { exact: true }).fill('100'); await page.getByLabel('Maximum output rows', { exact: true }).blur();
 await page.getByLabel('Input rows', { exact: true }).selectOption('applied');
 await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('left', [{field:'value', op:'eq', value:'2'}]));
 await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 await page.getByRole('button', { name: 'Preview join', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('1 output rows');
 await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('left', [{field:'value', op:'eq', value:'3'}]));
 await expect(page.getByRole('button', { name: 'Save joined dataset', exact: true })).toBeDisabled();
 await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 await page.getByRole('button', { name: 'Preview join', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('1 unmatched left rows');
 await page.getByRole('button', { name: 'Save joined dataset', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('Saved Joined snapshot · 1 rows');
 await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[2].done && !(window as any).__WFS_MAP__.sources[2].filtering);
 await navigate(page, 'records');
 const id = await page.evaluate(() => (window as any).__WFS_MAP__.sources[2].id); await page.locator('#recordsSource').selectOption(id); await expect(tableStatus(page)).toContainText('1 table rows');
 await expect(page.locator('.record-row').first()).toContainText('null');
});

test('WFS and CSV join on a shared numeric field, and failed storage never publishes a source', async ({ page }) => {
 await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
  { id: 'wfs', name: 'WFS', enabled: true, config: { ...config, url: '/wfs?points=8', layer: 'demo:points' } },
  { id: 'csv', name: 'CSV', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', csvText: 'lon,lat,id,annotation\n-1,54,0,zero\n-2,53,1,one' } },
 ] })), defaultConfig);
 await page.goto('/?time=all#derived'); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
 await page.getByLabel('Left match field', { exact: true }).selectOption('id'); await page.getByLabel('Right match field', { exact: true }).selectOption('id');
 await page.getByLabel('New dataset name', { exact: true }).fill('WFS annotations');
 await page.getByRole('button', { name: 'Preview join', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('2 output rows');
 await page.evaluate(() => { const set = Storage.prototype.setItem; (window as any).restoreStorage = () => { Storage.prototype.setItem = set; }; Storage.prototype.setItem = function(key, value) { if (key === 'wfs-settings') throw Error('Simulated quota'); return set.call(this, key, value); }; });
 await page.getByRole('button', { name: 'Save joined dataset', exact: true }).click(); await expect(page.locator('#derivedDatasets [role=alert]')).toContainText('Simulated quota');
 expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.length)).toBe(2);
 expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!).sources.length)).toBe(2);
 await page.evaluate(() => (window as any).restoreStorage());
 await page.getByRole('button', { name: 'Save joined dataset', exact: true }).click(); await expect(page.locator('#joinStatus')).toContainText('Saved WFS annotations');
 await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[2].done);
 expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[2].loaded)).toBe(2);
});

test('saving a join preserves pending Data sources edits until they are explicitly saved or discarded', async ({ page }) => {
 await csvPair(page);
 await navigate(page, 'configuration'); await page.getByRole('button', {name:'Configure Left input', exact:true}).click();
 await page.locator('#sourceName').fill('Renamed input'); await page.locator('#updateSource').click();
 await navigate(page, 'derived');
 await page.getByRole('button', {name:'Preview join', exact:true}).click(); await expect(page.locator('#joinStatus')).toContainText('3 output rows');
 await page.getByRole('button', {name:'Save joined dataset', exact:true}).click();
 await expect(page.locator('#derivedDatasets [role=alert]')).toContainText('Save or discard your pending changes');
 expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.length)).toBe(2);
 await navigate(page, 'configuration'); await expect(page.locator('#sourceList')).toContainText('Renamed input');
 await expect(page.locator('#saveSettings')).toBeEnabled(); await page.locator('#saveSettings').click();
 await navigate(page, 'derived');
 await page.getByRole('button', {name:'Preview join', exact:true}).click(); await expect(page.locator('#joinStatus')).toContainText('3 output rows');
 await page.getByRole('button', {name:'Save joined dataset', exact:true}).click(); await expect(page.locator('#joinStatus')).toContainText('Saved Joined snapshot');
 await navigate(page, 'configuration'); await expect(page.locator('#sourceList')).toContainText('Renamed input'); await expect(page.locator('#sourceList .source-row')).toHaveCount(3);
});

test('a join can be cancelled while its worker starts, without adding a source', async ({ page }) => {
 await csvPair(page);
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 await page.route('**/assets/derived-worker-*.js', async route => { await gate; await route.continue().catch(() => {}); });
 await page.getByRole('button', {name:'Preview join', exact:true}).click();
 await expect(page.getByRole('button', {name:'Cancel join', exact:true})).toBeVisible();
 await page.getByRole('button', {name:'Cancel join', exact:true}).click();
 await expect(page.locator('#derivedDatasets [role=alert]')).toContainText('Join cancelled');
 await expect(page.getByRole('button', {name:'Save joined dataset', exact:true})).toBeDisabled();
 expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.length)).toBe(2);
 release(); await page.unrouteAll({ behavior: 'wait' });
 await page.getByRole('button', {name:'Preview join', exact:true}).click(); await expect(page.locator('#joinStatus')).toContainText('3 output rows');
});
