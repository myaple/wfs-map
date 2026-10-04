import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'America/New_York', locale: 'en-US' });

test('CSV uploads, filter entry, metadata, and custom ranges stay UTC in a 12-hour locale', async ({ page }) => {
    await page.goto('/?time=all#configuration');
    await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('UTC observations');
    await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles({ name: 'utc.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,when\n-1,54,2026-03-08T02:30:00\n-2,53,2026-03-08T04:30:00+02:00\n-3,52,2026-03-08T03:30:00Z') });
    await expect(page.locator('#csvFileStatus')).toContainText('3 columns');
    await page.locator('#csvTime').selectOption('when');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
    await page.locator('#analysisLink').click();
    await page.evaluate(() => (window as any).__WFS_MAP__.getPoint(1));
    await expect(page.locator('.metadata')).toContainText('2026-03-08 02:30:00 UTC');
    await page.locator('.maplibregl-popup-close-button').click();
    await page.locator('#addRule').click();
    await page.getByLabel('Attribute', { exact: true }).selectOption('when');
    await page.getByLabel('Filter value').fill('2026-03-08 02:30:00');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('2 matches');
    await page.locator('#reset').click();
    await page.locator('#timeWindow').selectOption('custom');
    await expect(page.locator('#timeStart')).toHaveAttribute('type', 'text');
    await expect(page.locator('#utcTimeHelp')).toContainText('24-hour clock');
    await page.locator('#timeStart').fill('2026-03-08 02:30:00');
    await page.locator('#timeEnd').fill('2026-03-08 02:31:00');
    await page.locator('#applyTime').click();
    await expect.poll(() => page.evaluate(() => (window as any).__WFS_MAP__.sources[0].loaded)).toBe(2);
    await expect(page.locator('#timeSummary')).toHaveText('2026-03-08 02:30:00 UTC → 2026-03-08 02:31:00 UTC');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.queryBounds.time)).toEqual({ start: '2026-03-08T02:30:00.000Z', end: '2026-03-08T02:31:00.000Z' });
});

test('saved analysis timestamps display UTC and 24-hour time', async ({ page }) => {
    await page.route('**/api/analyses', route => route.fulfill({ json: [{ id: 'utc-analysis', name: 'UTC saved analysis', updatedAt: '2026-10-04T15:36:38+01:00', shared: false }] }));
    await page.goto('/');
    await expect(page.locator('.analysis-card .hint')).toHaveText('Saved 2026-10-04 14:36:38 UTC');
});
