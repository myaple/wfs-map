import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseCSV } from '../../src/csv.ts';
const original = '\uFEFFlon,lat,id,value,when,active\r\n-1,54,000123,3,2026-10-01 12:30,true\r\n-2,53,000124,N/A,2026-10-01T14:30+02:00,false\r\n-3,52,000125,bad,2026-02-30,yes\r\n-4,95,000126,5,2026-10-02,true\r\n-5,51,000127,,,false\r\n';
const file = { name: 'review.csv', mimeType: 'text/csv', buffer: Buffer.from(original) };

test('CSV review agrees with load, diagnostics, export, original local file and reload', async ({ page }) => {
    const errors: string[] = [], payloads: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (request.postData()) payloads.push(request.postData()!); });
    await page.goto('/?time=all#configuration');
    await page.locator('#addSource').click(); await page.locator('#sourceName').fill('Review');
    await page.locator('#type').selectOption('csv'); await page.locator('#csvFile').setInputFiles(file);
    await expect(page.locator('#csvSchema')).toContainText('Failed casts');
    await expect(page.getByLabel('Import type for id', { exact: true })).toHaveValue('');
    await expect(page.locator('#csvSamples')).toContainText('000123');
    await page.locator('#csvTime').selectOption('when');
    await page.getByLabel('Import type for id', { exact: true }).selectOption('string');
    await page.getByLabel('Import type for value', { exact: true }).selectOption('number');
    await page.getByLabel('Import type for active', { exact: true }).selectOption('boolean');
    await expect(page.locator('#csvReviewStatus')).toContainText('5 records · 3 valid · 2 invalid');
    await expect(page.locator('#csvReviewStatus')).toContainText('Entire import rejected');
    await expect(page.locator('#updateSource')).toBeDisabled();
    await expect(page.locator('#csvSchema tr').filter({ has: page.getByText('value', { exact: true }) })).toContainText('2');
    const diagnosticsDownload = page.waitForEvent('download'); await page.locator('#csvDiagnostics').click();
    const diagnostics = parseCSV(await readFile((await (await diagnosticsDownload).path())!, 'utf8'));
    expect(diagnostics.rows).toHaveLength(4);
    expect([...new Set(diagnostics.rows.map(row => row[0]))]).toEqual(['4', '5']);
    await page.locator('#csvInvalidRows').selectOption('quarantine');
    await expect(page.locator('#csvReviewStatus')).toContainText('3 accepted / 2 quarantined');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('#sourceDialog').evaluate(d => d.scrollWidth <= d.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    await page.locator('#analysisLink').click(); await expect(page.locator('#hud')).toHaveText('Loaded 3 points');
    await expect(page.locator('#status')).toContainText('2 invalid records quarantined');
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!));
    const config = state.sources[0].config;
    expect(config.csvText).toBe(''); expect(config.csvInvalidRows).toBe('quarantine');
    expect(JSON.parse(config.csvTypes)).toEqual({ id: 'string', value: 'number', active: 'boolean' });
    const raw = await page.evaluate(async ref => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('wfs-source-files', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
            const blob = await new Promise<Blob>((resolve, reject) => { const r = db.transaction('csv').objectStore('csv').get(ref); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer());
        } finally { db.close(); }
    }, config.csvRef);
    expect(raw).toBe(original);
    const exportDownload = page.waitForEvent('download'); await page.locator('#exportCSV').click();
    const exported = parseCSV(await readFile((await (await exportDownload).path())!, 'utf8'));
    expect(exported.rows.map(row => row[exported.headers.indexOf('id')])).toEqual(['000123', '000124', '000127']);
    expect(exported.rows[0][exported.headers.indexOf('when')]).toBe('2026-10-01T12:30:00.000Z');
    expect(exported.rows[1][exported.headers.indexOf('value')]).toBe('');
    await page.reload(); await expect(page.locator('#hud')).toHaveText('Loaded 3 points');
    await page.locator('#configLink').click(); await page.getByRole('button', { name: 'Configure Review', exact: true }).click();
    await expect(page.locator('#csvReviewStatus')).toContainText('3 accepted / 2 quarantined');
    await expect(page.getByLabel('Import type for id', { exact: true })).toHaveValue('string');
    await expect(page.getByLabel('Import type for active', { exact: true })).toHaveValue('boolean');
    expect(payloads.every(body => !body.includes('000123') && !body.includes('000125'))).toBe(true);
    expect(errors).toEqual([]);
});

test('large review stays responsive, cancels without saving, and can restart or replace the file', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/?time=all#configuration'); await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('Large'); await page.locator('#type').selectOption('csv');
    // Track main-thread animation frames while the worker parses and validates.
    await page.evaluate(() => { (window as any).__frames = 0; const frame = () => { (window as any).__frames++; requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
    await page.locator('#csvFile').setInputFiles({ name: 'million.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,id,value\n' + '-1,54,000123,3\n'.repeat(1_000_000)) });
    await expect(page.locator('#cancelCSV')).toBeVisible(); await page.locator('#cancelCSV').click();
    await expect(page.locator('#csvReviewStatus')).toContainText('Review cancelled');
    await expect(page.locator('#updateSource')).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem('wfs-settings'))).toBeNull();
    await page.locator('#refreshCSV').click();
    await expect(page.locator('#csvReviewStatus')).toContainText('1,000,000 records', { timeout: 120_000 });
    await expect(page.locator('#updateSource')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__frames)).toBeGreaterThan(10);
    await page.locator('#csvFile').setInputFiles({ name: 'small.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,id\n-1,54,000007') });
    await expect(page.locator('#csvReviewStatus')).toContainText('1 records · 1 valid · 0 invalid');
    await expect(page.locator('#csvSchema tr')).toHaveCount(4); // header plus three columns
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    await expect(page.locator('#sourceList')).toContainText('small.csv');
});

test('custom missing tokens invalidate review immediately and persist with the schema', async ({ page }) => {
    await page.goto('/?time=all#configuration'); await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('Custom missing'); await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles({ name: 'missing.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,value\n-1,54, MISSING \n-2,53,12') });
    await page.getByLabel('Import type for value', { exact: true }).selectOption('number');
    await expect(page.locator('#csvReviewStatus')).toContainText('1 valid · 1 invalid');
    await page.locator('#csvMissingValues').fill('MISSING');
    await expect(page.locator('#updateSource')).toBeDisabled();
    await expect(page.locator('#csvReviewStatus')).toContainText('tokens changed');
    await page.locator('#csvMissingValues').press('Tab');
    await expect(page.locator('#csvReviewStatus')).toContainText('2 valid · 0 invalid');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    const config = await page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!).sources[0].config);
    expect(JSON.parse(config.csvMissingValues)).toEqual(['', 'MISSING']);
    await page.reload(); await page.getByRole('button', { name: 'Configure Custom missing', exact: true }).click();
    await expect(page.locator('#csvReviewStatus')).toContainText('2 valid · 0 invalid');
    await expect(page.locator('#csvMissingValues')).toHaveValue('MISSING');
    await expect(page.getByLabel('Import type for value', { exact: true })).toHaveValue('number');
});
