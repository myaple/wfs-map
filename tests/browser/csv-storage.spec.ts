import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, name = 'CSV') {
    await page.locator('#addSource').click();
    await page.locator('#sourceName').fill(name); await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles(file);
    await expect(page.locator('#csvFileStatus')).toContainText(/\d+ columns/, { timeout: 120_000 });
    if (await page.locator('#csvTime option[value=timestamp]').count()) await page.locator('#csvTime').selectOption('timestamp');
    await page.locator('#updateSource').click();
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!));
const keys = (page: Page) => page.evaluate(async () => {
    const { indexedDB } = window;
    return await new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('wfs-source-files', 1);
        open.onsuccess = () => {
            const db = open.result, tx = db.transaction('csv'), request = tx.objectStore('csv').getAllKeys();
            tx.oncomplete = () => { resolve(request.result as string[]); db.close(); };
            tx.onabort = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
    });
});
const smallCSV = (value: number) => ({ name: 'points.csv', mimeType: 'text/csv', buffer: Buffer.from(`lon,lat,value\n-1,54,${value}`) });

test('million-row CSV saves beyond localStorage quota and reloads from IndexedDB', async ({ page }) => {
    test.setTimeout(240_000);
    const dir = mkdtempSync(join(tmpdir(), 'wfs-million-'));
    const file = process.env.WFS_CSV_SAMPLE ?? join(dir, 'million.csv');
    if (!process.env.WFS_CSV_SAMPLE) {
        // File exceeds Chromium's localStorage quota without committing a huge fixture.
        writeFileSync(file, 'id,longitude,latitude,value\n' + '1,-1,54,123.456789\n'.repeat(1_000_000));
    }
    try {
        const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto('/?time=all&autoload=1');
        await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
        await page.locator('#configLink').click();
        await importFile(page, file, 'Million points');
        await page.locator('#saveSettings').click();
        await expect(page.locator('#saveState')).toHaveText('Saved in this browser', { timeout: 120_000 });
        await expect(page.locator('#saveError')).toBeHidden();
        const settings = await saved(page), ref = settings.sources[0].config.csvRef;
        expect(settings.sources[0].config.csvText).toBe(''); expect(ref).toBeTruthy();
        expect(await page.evaluate(() => localStorage.getItem('wfs-settings')!.length)).toBeLessThan(10_000);
        expect(await keys(page)).toEqual([ref]);
        await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done, undefined, { timeout: 120_000 });
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBe(1_000_000);
        await page.reload();
        await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done, undefined, { timeout: 120_000 });
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBe(1_000_000);
        await page.locator('#configLink').click();
        await page.getByRole('button', { name: 'Configure Million points', exact: true }).click();
        await expect(page.locator('#csvFileStatus')).toContainText(/\d+ columns/, { timeout: 120_000 });
        await page.locator('#sourceName').fill('Renamed million'); await page.locator('#updateSource').click();
        await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
        expect((await saved(page)).sources[0].config.csvRef).toBe(ref);
        expect(await keys(page)).toEqual([ref]); expect(errors).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed CSV replacement preserves the old file, supports retry, and cleans up removal', async ({ page }) => {
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await page.locator('#configLink').click();
    await importFile(page, smallCSV(1)); await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    const before = await saved(page), ref = before.sources[0].config.csvRef;
    await page.getByRole('button', { name: 'Configure CSV', exact: true }).click();
    await expect(page.locator('#csvFileStatus')).toContainText('3 columns');
    await page.locator('#csvFile').setInputFiles(smallCSV(2));
    await expect(page.locator('#updateSource')).toBeEnabled(); await page.locator('#updateSource').click();
    await page.evaluate(() => {
        (window as any).__add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function(...args: any[]) {
            const request = (window as any).__add.apply(this, args); this.transaction.abort(); return request;
        };
    });
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveError')).toContainText('interrupted');
    expect(await saved(page)).toEqual(before); expect(await keys(page)).toEqual([ref]);
    await page.evaluate(() => IDBObjectStore.prototype.add = (window as any).__add);
    await page.evaluate(() => { (window as any).__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveError')).toContainText('Storage full');
    expect(await saved(page)).toEqual(before); expect(await keys(page)).toEqual([ref]);
    await expect(page.locator('#saveSettings')).toBeEnabled();
    await page.evaluate(() => Storage.prototype.setItem = (window as any).__setItem);
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    const replacement = (await saved(page)).sources[0].config.csvRef;
    expect(replacement).not.toBe(ref); expect(await keys(page)).toEqual([replacement]);
    await page.reload(); await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    await page.evaluate(async () => { (window as any).__WFS_MAP__.getPoint(0); });
    await expect(page.locator('.metadata')).toContainText('2');
    await page.locator('#configLink').click();
    await page.getByRole('button', { name: 'Remove CSV', exact: true }).click();
    await page.locator('#undoRemove').click(); expect(await keys(page)).toEqual([replacement]);
    await page.getByRole('button', { name: 'Remove CSV', exact: true }).click();
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    expect(await keys(page)).toEqual([]);
});

test('inline CSV settings migrate on save and IndexedDB failures leave drafts intact', async ({ page }) => {
    await page.addInitScript(() => {
        if (localStorage.getItem('wfs-settings')) return;
        localStorage.setItem('wfs-settings', JSON.stringify({ sources: [{ id: 'legacy', name: 'Legacy CSV', enabled: true, config: { type: 'csv', url: '', csvText: 'lon,lat,value\n-1,54,7', fileName: 'old.csv', longitudeField: 'lon', latitudeField: 'lat' } }] }));
    });
    await page.goto('/?time=all&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await page.locator('#configLink').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    await page.getByRole('button', { name: 'Configure Legacy CSV', exact: true }).click();
    await page.locator('#sourceName').fill('Migrated CSV'); await page.locator('#updateSource').click();
    await page.evaluate(() => { (window as any).__open = indexedDB.open; indexedDB.open = () => { throw new DOMException('File storage full', 'QuotaExceededError'); }; });
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveError')).toContainText('File storage full');
    expect((await saved(page)).sources[0].config.csvText).toContain('54,7');
    await page.evaluate(() => indexedDB.open = (window as any).__open);
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    expect((await saved(page)).sources[0].config.csvText).toBe('');
    await page.reload(); await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBe(1);
});
