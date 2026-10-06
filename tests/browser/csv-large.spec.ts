import { navigate } from '../navigation.ts';
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvStressFixture } from '../../scripts/csv-stress-fixture.mjs';
import { parseCSV } from '../../src/csv.ts';

test('200 MB CSV with two million rows, 16 columns and two unique text columns imports and reloads without crashing', async ({ page }) => {
    test.setTimeout(240_000);
    const directory = await mkdtemp(join(tmpdir(), 'wfs-csv-stress-'));
    const file = join(directory, '2m-16cols.csv');
    const errors: string[] = []; let crashed = false;
    page.on('pageerror', e => errors.push(e.message)); page.on('crash', () => crashed = true);
    try {
        const fixture = await csvStressFixture(file);
        expect(fixture).toMatchObject({ rows: 2_000_000, columns: 16, bytes: 200_000_091 });
        await page.addInitScript(() => {
            // Reading the whole file into a JS string caused the original OOM.
            (window as any).__csvFullTextReads = 0;
            const read = Blob.prototype.text;
            Blob.prototype.text = function() { (window as any).__csvFullTextReads++; return read.call(this); };
        });
        await page.goto('/?time=all#configuration');
        await page.locator('#addSource').click(); await page.locator('#sourceName').fill('200 MB CSV'); await page.locator('#type').selectOption('csv');
        await page.locator('#csvFile').setInputFiles(file);
        await expect(page.locator('#csvFileStatus')).toContainText('16 columns');
        expect(await page.evaluate(() => (window as any).__csvFullTextReads)).toBe(0);
        await page.locator('#csvTime').selectOption('timestamp');
        await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
        await expect(page.locator('#saveState')).toContainText('Saved in this browser');
        await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done && !(window as any).__WFS_MAP__.sources[0].filtering, undefined, { timeout: 120_000 });
        const source = await page.evaluate(() => { const s = (window as any).__WFS_MAP__.sources[0]; return { loaded: s.loaded, fields: s.fields, report: s.metrics.csvReport }; });
        expect(source.loaded).toBe(2_000_000); expect(source.fields).toHaveLength(16);
        expect(source.report).toMatchObject({ total: 2_000_000, imported: 2_000_000, rejected: 0, filtered: 0 });
        const records = await page.evaluate(async () => {
            const worker = (window as any).__WFS_MAP__.sources[0].worker as Worker;
            return await new Promise<any[]>(resolve => {
                const listener = (event: MessageEvent) => {
                    if (event.data.type !== 'metadataMany' || event.data.token !== -101) return;
                    worker.removeEventListener('message', listener); resolve(event.data.rows);
                };
                worker.addEventListener('message', listener);
                worker.postMessage({ type: 'getMany', token: -101, indices: [0, 1_234_567, 1_999_999] });
            });
        });
        for (const record of records) {
            expect(record.data.id).toBe('csv.' + (record.index + 2));
            expect(record.data.properties.unique_a).toBe('a-' + String(record.index).padStart(16, '0'));
            expect(record.data.properties.unique_b).toBe('b-' + String(record.index).padStart(17, '0'));
            expect(record.data.properties.n11).toBe(record.index % 10);
        }
        await navigate(page, 'analysis');
        await page.evaluate(() => {
            const app = (window as any).__WFS_MAP__, s = app.sources[0];
            app.filterSource(s.id, [{ field: 'unique_b', op: 'eq', value: 'b-' + String(1_234_567).padStart(17, '0') }]);
        });
        await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering && (window as any).__WFS_MAP__.sources[0].selected === 1);
        const download = page.waitForEvent('download'); await page.locator('#exportCSV').click();
        const csv = parseCSV(await readFile((await (await download).path())!, 'utf8'));
        expect(csv.rows).toHaveLength(1);
        expect(csv.rows[0][csv.headers.indexOf('unique_b')]).toBe('b-00000000001234567');
        await page.reload();
        await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done && !(window as any).__WFS_MAP__.sources[0].filtering, undefined, { timeout: 120_000 });
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBe(2_000_000);
        expect(await page.evaluate(() => (window as any).__csvFullTextReads)).toBe(0);
        expect(crashed).toBe(false); expect(errors).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
