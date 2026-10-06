import { navigate } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackup } from '../../src/source-backup.ts';

const small = 'lon,lat,name,value\r\n-1,54,"café, north",1\r\n-2,53,south,2\r\n-3,52,west,3\r\n';
const large = 'lon,lat,name,value\n' + '-1,54,complete-metadata,123.456789\n'.repeat(200_000);
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!));
const csvFiles = (page: Page) => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('wfs-source-files', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const readCSVText = (ref: string) => new Promise<string>((resolve, reject) => {
        const tx = db.transaction('csv'), request = tx.objectStore('csv').get(ref);
        tx.oncomplete = () => request.result.text().then(resolve, reject); tx.onabort = () => reject(tx.error);
    });
    const settings = JSON.parse(localStorage.getItem('wfs-settings')!);
    try { return await Promise.all(settings.sources.filter((s: any) => s.config.type === 'csv').map(async (s: any) => ({ id: s.id, text: await readCSVText(s.config.csvRef) }))); } finally { db.close(); }
});
async function addCSV(page: Page, name: string, text: string) {
    await page.locator('#addSource').click();
    await page.locator('#sourceName').fill(name); await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles({ name: name + '.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await expect(page.locator('#csvFileStatus')).toContainText('4 columns');
    await page.locator('#updateSource').click();
}
const normalized = (settings: any) => ({ ...settings, sources: settings.sources.map((s: any) => ({ ...s, config: { ...s.config, csvRef: '' } })) });

async function downloadedBackup(page: Page) {
    const download = page.waitForEvent('download'); await page.locator('#exportBackup').click();
    const file = await download; expect(file.suggestedFilename()).toMatch(/^wfs-map-backup-.*\.tar\.gz$/);
    return { name: file.suggestedFilename(), mimeType: 'application/gzip', buffer: await readFile((await file.path())!) };
}

test('share a full backup into a fresh browser and reload its files, colours, WFS and map settings', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all&points=17');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
    await navigate(page, 'configuration');
    await addCSV(page, 'Active CSV', small);
    await addCSV(page, 'Disabled large CSV', large);
    await page.getByRole('checkbox', { name: 'Enable Disabled large CSV', exact: true }).uncheck();
    await page.locator('#backgroundSettings summary').click();
    await page.locator('#basemapURL').fill('https://tiles.example/{z}/{x}/{y}.png');
    await page.locator('#basemapAttribution').fill('Shared basemap ©');
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[1]?.done);
    await navigate(page, 'analysis');
    const activeID = (await saved(page)).sources[1].id;
    await page.locator('#colorSource').selectOption(activeID);
    await page.locator('#sourceColor').evaluate((el: HTMLInputElement) => { el.value = '#aabbcc'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#size').evaluate((el: HTMLInputElement) => { el.value = '4.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => {
        const app = (window as any).__WFS_MAP__;
        app.filterSource(app.sources[1].id, [{ field: 'value', op: 'eq', value: '2' }]);
        app.map.jumpTo({ center: [-1.54, 53.99], zoom: 12.5 });
    });
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[1].selected === 1);
    const before = await saved(page), beforeFiles = await csvFiles(page);
    await navigate(page, 'configuration'); const archive = await downloadedBackup(page);
    expect(archive.buffer.length).toBeLessThan(100_000);
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8787' }), receiver = await context.newPage();
    receiver.on('pageerror', e => errors.push(e.message));
    try {
        await receiver.goto('/?time=all#configuration');
        await receiver.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
        await receiver.locator('#backupFile').setInputFiles(archive);
        await expect(receiver.locator('#backupDialog')).toBeVisible();
        await expect(receiver.locator('#backupSummary')).toContainText('3 sources: 2 CSV files and 1 WFS connections');
        await receiver.locator('#restoreBackup').click();
        await expect(receiver.locator('#backupStatus')).toHaveText('Backup restored and saved in this browser.');
        await receiver.waitForFunction(() => (window as any).__WFS_MAP__?.sources.filter((s: any) => s.enabled).every((s: any) => s.done));
        expect(normalized(await saved(receiver))).toEqual(normalized(before));
        expect(await csvFiles(receiver)).toEqual(beforeFiles);
        const after = await saved(receiver);
        expect(after.sources[1].config.csvRef).not.toBe(before.sources[1].config.csvRef);
        expect(await receiver.evaluate(() => (window as any).__WFS_MAP__.sources.map((s: any) => s.loaded))).toEqual([17, 3, 0]);
        expect(await receiver.evaluate(() => (window as any).__WFS_MAP__.sources[1].selected)).toBe(3);
        await navigate(receiver, 'analysis'); await expect(receiver.locator('#size')).toHaveValue('4.5');
        const view = await receiver.evaluate(() => { const m = (window as any).__WFS_MAP__.map; return { center: m.getCenter().toArray(), zoom: m.getZoom() }; });
        expect(view.center[0]).toBeCloseTo(-1.54, 7); expect(view.center[1]).toBeCloseTo(53.99, 7); expect(view.zoom).toBeCloseTo(12.5);
        await receiver.reload(); await receiver.waitForFunction(() => (window as any).__WFS_MAP__?.sources[1]?.done);
        expect(await csvFiles(receiver)).toEqual(beforeFiles); expect(normalized(await saved(receiver))).toEqual(normalized(before));
        expect(errors).toEqual([]);
    } finally { await context.close(); }
});

test('draft export, cancelled restore, invalid archive and failed storage preserve existing sources', async ({ page }) => {
    await page.goto('/?time=all#configuration');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await addCSV(page, 'Unsaved CSV', small);
    const archive = await downloadedBackup(page);
    await page.reload();
    const empty = await saved(page);
    await page.locator('#backupFile').setInputFiles(archive);
    await expect(page.locator('#backupDialog')).toBeVisible(); await page.locator('#cancelBackup').click();
    expect(await saved(page)).toEqual(empty); await expect(page.locator('#sourceList .source-row')).toHaveCount(0);
    await page.locator('#backupFile').setInputFiles(archive); await page.locator('#restoreBackup').click();
    await expect(page.locator('#backupStatus')).toContainText('Backup restored');
    const original = await saved(page), originalFiles = await csvFiles(page);
    await page.locator('#backupFile').setInputFiles({ name: 'bad.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('bad archive') });
    await expect(page.locator('#backupError')).toContainText('Could not import backup');
    expect(await saved(page)).toEqual(original); expect(await csvFiles(page)).toEqual(originalFiles);
    await page.locator('#backupFile').setInputFiles(archive);
    await page.evaluate(() => {
        (window as any).__setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) { if (key === 'wfs-settings') throw new DOMException('Storage full', 'QuotaExceededError'); (window as any).__setItem.call(this, key, value); };
    });
    await page.locator('#restoreBackup').click(); await expect(page.locator('#restoreError')).toContainText('Storage full');
    expect(await saved(page)).toEqual(original); expect(await csvFiles(page)).toEqual(originalFiles);
    await page.evaluate(() => Storage.prototype.setItem = (window as any).__setItem);
    await page.locator('#restoreBackup').click(); await expect(page.locator('#backupDialog')).toBeHidden();
    expect(await csvFiles(page)).toEqual(originalFiles);
    // Restore the same source ID with different contents and colours. An old
    // immutable IndexedDB reference or live worker must never win over the tar.
    const replacement = structuredClone(original);
    replacement.sources[0].config.csvText = small.replace('south,2', 'replacement,99');
    replacement.sources[0].color = [1, 0, 0];
    (globalThis as any).location = { href: 'http://127.0.0.1:8787/' };
    const changed = await createBackup(replacement, async () => { throw Error('Use inline file'); });
    await page.locator('#backupFile').setInputFiles({ name: 'replacement.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(await changed.arrayBuffer()) });
    await page.locator('#restoreBackup').click(); await expect(page.locator('#backupDialog')).toBeHidden();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
    expect((await csvFiles(page))[0].text).toBe(replacement.sources[0].config.csvText);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].layer.color)).toEqual([1, 0, 0]);
    await navigate(page, 'analysis');
    await page.evaluate(() => (window as any).__WFS_MAP__.getPoint(1));
    await expect(page.locator('.metadata')).toContainText('replacement');
    await expect(page.locator('.metadata')).toContainText('99');
});
