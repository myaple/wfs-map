import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseCSV } from '../../src/csv.ts';
import { defaultConfig } from '../../src/source-settings.ts';
import { feature } from '../../server/demo.ts';

async function download(page: Page) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
    const file = await pending;
    return { filename: file.suggestedFilename(), ...parseCSV(await readFile((await file.path())!, 'utf8')) };
}

test('CSV downloads isolate sources and export the applied AND/OR and chart selection without reloading WFS', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(config => {
        localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
            { id: 'a', name: 'First', enabled: true, config: { ...config, url: '/wfs?points=32', layer: 'demo:points', pageSize: '8' } },
            { id: 'b', name: 'Second', enabled: true, config: { ...config, url: '/wfs?points=16', layer: 'demo:points' } },
            { id: 'c', name: 'Disabled', enabled: false, config },
        ] }));
    }, defaultConfig);
    let requests = 0; page.on('request', r => { if (new URL(r.url()).searchParams.get('request') === 'GetFeature') requests++; });
    await page.goto('/?time=all'); await expect(page.locator('#exportCSV')).toBeEnabled();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources.slice(0, 2).every((s: any) => s.done && !s.filtering));
    const before = requests;
    const first = await download(page);
    expect(first.filename).toBe('First-filtered.csv'); expect(first.rows).toHaveLength(32);
    // Nested groups are the same expression used by the map and charts.
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('a', { op: 'or', children: [
        { op: 'and', children: [{ field: 'category', op: 'eq', value: 'sensor' }, { field: 'quality', op: 'gte', value: '50' }] },
        { op: 'row', index: 3 },
    ] }));
    await expect(page.locator('#filterStatus')).toContainText('matches');
    const filtered = await download(page);
    const expected = Array.from({ length: 32 }, (_, i) => feature(i)).filter((f, i) => i === 3 || f.properties.category === 'sensor' && Number(f.properties.quality) >= 50);
    expect(filtered.rows.map(r => r[0])).toEqual(expected.map(f => f.id));
    await page.locator('#filterSource').selectOption('b');
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'eq', value: 'sensor' }, 'Sensors'));
    await expect(page.locator('#filterStatus')).toContainText('Second · 4 matches');
    await page.locator('#exportSource').selectOption('b');
    expect((await download(page)).rows).toHaveLength(4);
    await page.locator('#reset').click(); await expect(page.locator('#filterStatus')).toContainText('Second · 16 matches');
    expect((await download(page)).rows).toHaveLength(16);
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('b', [{ field: 'category', op: 'eq', value: 'absent' }]));
    await expect(page.locator('#filterStatus')).toContainText('0 matches');
    expect((await download(page)).rows).toHaveLength(0);
    await page.locator('#exportSource').selectOption('c'); await expect(page.locator('#exportCSV')).toBeDisabled();
    expect(requests).toBe(before); expect(errors).toEqual([]);
});

test('CSV source export combines time, map-area bounds and local filters, retaining original row IDs', async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'csv', name: 'CSV stations', enabled: true, config: { ...config, type: 'csv', longitudeField: 'lon', latitudeField: 'lat', timeField: 'observed', csvText: 'lon,lat,observed,temp,station\n-1,54,2026-10-01T12:00:00Z,7,north\n-2,53,2026-10-02T12:00:00Z,9,south\n-10,50,2026-10-02T12:00:00Z,12,outside' } },
    ] })), defaultConfig);
    await page.goto('/?time=all'); await expect(page.locator('#exportCSV')).toBeEnabled();
    await page.locator('#timeWindow').selectOption('custom');
    await page.locator('#timeStart').fill('2026-10-02T00:00'); await page.locator('#timeEnd').fill('2026-10-03T00:00'); await page.locator('#applyTime').click();
    await expect(page.locator('#csvExportStatus')).toHaveText('2 matching points');
    await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-2, 53], zoom: 6 }));
    const canvas = page.locator('#map canvas'); await canvas.scrollIntoViewIfNeeded(); const b = (await canvas.boundingBox())!;
    await page.mouse.move(b.x + b.width * .4, b.y + b.height * .4); await page.mouse.down({ button: 'right' });
    await page.mouse.move(b.x + b.width * .6, b.y + b.height * .6, { steps: 4 }); await page.mouse.up({ button: 'right' });
    await expect(page.locator('#csvExportStatus')).toHaveText('1 matching points');
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'temp', op: 'gte', value: '8' }, 'Warm stations'));
    await expect(page.locator('#filterStatus')).toContainText('1 matches');
    const csv = await download(page);
    expect(csv.filename).toBe('CSV-stations-filtered.csv'); expect(csv.rows).toHaveLength(1);
    expect(csv.rows[0][0]).toBe('csv.3'); expect(csv.rows[0].at(-1)).toBe('south');
});

test('limited loads export loaded points and changing filters or clearing cancels an in-progress download', async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: [
        { id: 'a', name: 'Limited', enabled: true, config: { ...config, url: '/wfs?points=20000', layer: 'demo:points', limit: '15000' } },
    ] })), defaultConfig);
    await page.goto('/?time=all'); await expect(page.locator('#exportCSV')).toBeEnabled();
    await expect(page.locator('#csvExportStatus')).toContainText('load limit reached');
    expect((await download(page)).rows).toHaveLength(15000);
    await expect(page.locator('#csvExportStatus')).toContainText('load limit reached');
    const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
    const pendingDisabled = await page.evaluate(() => {
        document.getElementById('exportCSV')!.click();
        (window as any).__WFS_MAP__.filterSource('a', [{ field: 'category', op: 'eq', value: 'sensor' }]);
        return (document.getElementById('exportCSV') as HTMLButtonElement).disabled;
    });
    expect(pendingDisabled).toBe(true);
    await expect(page.locator('#exportCSV')).toBeEnabled();
    // A later successful export confirms that no old request downloaded first.
    expect((await download(page)).rows).toHaveLength(3750);
    expect(downloads).toHaveLength(1);
    await page.evaluate(() => {
        document.getElementById('exportCSV')!.click();
        document.getElementById('cancel')!.click();
    });
    await expect(page.locator('#exportCSV')).toBeDisabled();
    expect(downloads).toHaveLength(1);
});
