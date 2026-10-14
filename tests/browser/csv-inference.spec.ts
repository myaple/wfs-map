import { test, expect, type Page } from '@playwright/test';
const columns = ['position_east', 'position_north', 'observed_at', 'sma_nm', 'smi_m', 'ellipse_azimuth_deg'];
const fields = { longitudeField: columns[0], latitudeField: columns[1], timeField: columns[2], ellipseMajorField: columns[3], ellipseMinorField: columns[4], ellipseOrientationField: columns[5], ellipseMajorUnit: 'nm', ellipseMinorUnit: 'm' };
const result = { available: true, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, probability: .9, candidates: [{ value, probability: .9 }] }])) };
async function open(page: Page) {
    await page.goto('/?time=all#configuration'); await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('Model CSV'); await page.locator('#type').selectOption('csv');
}
async function upload(page: Page, name = 'points.csv', headers = columns) {
    await page.locator('#csvFile').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(headers.join(',') + '\n-1,54,2026-10-01,2,100,45') });
}
test('header-only inference fills all CSV mappings and persists separate axis units', async ({ page }) => {
    let payload: unknown;
    await page.route('**/api/csv/infer-fields', async route => { payload = route.request().postDataJSON(); await route.fulfill({ json: result }); });
    await open(page); await upload(page);
    await expect(page.locator('#csvInferenceStatus')).toContainText('suggestions applied');
    expect(payload).toEqual({ columns });
    for (const [key, value] of Object.entries(fields)) await expect(page.locator('#' + (key === 'timeField' ? 'csvTime' : key))).toHaveValue(value);
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
    await page.getByRole('button', { name: 'Configure Model CSV', exact: true }).click();
    await expect(page.locator('#ellipseMajorUnit')).toHaveValue('nm');
    await expect(page.locator('#csvTime')).toHaveValue('observed_at');
});
for (const mode of ['disabled', 'error', 'malformed'] as const) test(`CSV import keeps current detection with ${mode} inference`, async ({ page }) => {
    await page.route('**/api/csv/infer-fields', route => route.fulfill(mode === 'error' ? { status: 503, body: 'unavailable' } : mode === 'malformed' ? { body: 'bad json' } : { json: { available: false, fields: {} } }));
    await open(page); await upload(page, 'fallback.csv', ['lon', 'lat', 't', 'a', 'b', 'orientation']);
    await expect(page.locator('#longitudeField')).toHaveValue('lon'); await expect(page.locator('#latitudeField')).toHaveValue('lat');
    await expect(page.locator('#csvInferenceStatus')).toHaveText('');
    await expect(page.locator('#updateSource')).toBeEnabled(); await expect(page.locator('#sourceError')).toBeHidden();
});
test('late inference preserves manual edits and does not block adding the source', async ({ page }) => {
    let release!: () => void; const ready = new Promise<void>(resolve => release = resolve);
    await page.route('**/api/csv/infer-fields', async route => { await ready; await route.fulfill({ json: result }); });
    await open(page); await upload(page);
    await expect(page.locator('#csvInferenceStatus')).toContainText('Checking');
    await expect(page.locator('#updateSource')).toBeEnabled();
    await page.locator('#csvTime').selectOption('sma_nm');
    release(); await expect(page.locator('#csvInferenceStatus')).toContainText('suggestions applied');
    await expect(page.locator('#csvTime')).toHaveValue('sma_nm');
    await expect(page.locator('#latitudeField')).toHaveValue('position_north');
});
test('replacing a CSV cancels stale suggestions', async ({ page }) => {
    let release!: () => void; const ready = new Promise<void>(resolve => release = resolve);
    let count = 0;
    await page.route('**/api/csv/infer-fields', async route => {
        if (++count === 1) { await ready; await route.fulfill({ json: result }).catch(() => {}); }
        else await route.fulfill({ json: { available: false, fields: {} } });
    });
    await open(page); await upload(page);
    await expect(page.locator('#csvInferenceStatus')).toContainText('Checking');
    await upload(page, 'replacement.csv', ['lon', 'lat', 't', 'a', 'b', 'orientation']);
    await expect(page.locator('#csvFileStatus')).toContainText('replacement.csv');
    await expect(page.locator('#csvInferenceStatus')).toHaveText(''); release();
    await expect(page.locator('#longitudeField')).toHaveValue('lon'); await expect(page.locator('#csvTime')).toHaveValue('');
});
