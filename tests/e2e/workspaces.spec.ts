import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { emptyState, configurationState, type AnalysisDocument } from '../../src/analysis-state.ts';
import { defaultConfig } from '../../src/source-settings.ts';

const headers = (user = 'alice') => ({ Cookie: `wfs_test_user=${user}`, 'X-Workspace-Request': '1' });
async function create(request: APIRequestContext, state = emptyState(), user = 'alice') {
    const response = await request.post('/api/analyses', { headers: headers(user), data: { name: `E2E ${randomUUID()}`, state } });
    expect(response.status()).toBe(200);
    return await response.json() as AnalysisDocument;
}
async function remove(request: APIRequestContext, id: string, user = 'alice') {
    expect((await request.delete('/api/analyses/' + id, { headers: headers(user) })).status()).toBe(200);
}
function wfsState(points: number) {
    return configurationState({ sources: [{ id: 'wfs', name: 'WFS points', enabled: true, config: { ...defaultConfig, url: `/wfs?points=${points}`, layer: 'demo:points' } }], background: { url: '', attribution: '', enabled: false } }, { choice: 'all', bounds: {} }, []);
}
async function user(context: BrowserContext, baseURL: string, value: string) {
    await context.addCookies([{ name: 'wfs_test_user', value, url: baseURL }]);
}
async function attach(page: Page, text: string) {
    await page.locator('#configLink').click();
    await page.getByRole('button', { name: 'Configure Local stations', exact: true }).click();
    await page.locator('#csvFile').setInputFiles({ name: 'stations.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await expect(page.locator('#csvFileStatus')).toContainText('4 columns');
    await page.locator('#updateSource').click();
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    await page.locator('#analysisLink').click();
}
const save = async (page: Page) => {
    await page.getByRole('button', { name: 'Save analysis', exact: true }).click();
    await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved');
};

test('real API accepts normal GETs and empty mutations, enforces ownership and revokes read-only sharing', async ({ request }) => {
    const spoofed = await request.get('/api/me', { headers: { ...headers('bob'), 'X-E2E-User': 'alice', 'X-User-Id': 'alice' } });
    expect(spoofed.status()).toBe(200);
    expect(await spoofed.json()).toEqual({ user: 'bob' });
    expect(await (await request.get('/api/me', { headers: headers('bob') })).json()).toEqual({ user: 'bob' });
    expect((await request.get('/api/me', { headers: headers('none') })).status()).toBe(401);
    expect((await request.get('/api/me', { headers: { ...headers('none'), 'X-E2E-User': 'alice' } })).status()).toBe(401);
    expect((await request.get('/api/openapi.json')).status()).toBe(200);
    const doc = await create(request), path = '/api/analyses/' + doc.id;
    let copy: AnalysisDocument | undefined;
    try {
        const listed = await (await request.get('/api/analyses', { headers: headers('bob') })).json();
        expect(listed.some((d: AnalysisDocument) => d.id === doc.id)).toBe(false);
        expect((await request.get(path, { headers: headers('bob') })).status()).toBe(404);
        expect((await request.put(path, { headers: headers('bob'), data: { name: 'Hijack', state: doc.state, revision: 1 } })).status()).toBe(404);
        expect((await request.delete(path, { headers: headers('bob') })).status()).toBe(404);
        expect((await request.post(path + '/share', { headers: headers('bob') })).status()).toBe(404);
        expect((await request.delete(path + '/share', { headers: headers('bob') })).status()).toBe(404);
        expect((await request.put(path, { headers: { Cookie: 'wfs_test_user=alice' }, data: { name: doc.name, state: doc.state, revision: 1 } })).status()).toBe(403);
        expect((await request.put(path, { headers: headers(), data: { name: doc.name, state: { ...doc.state, csvText: 'PRIVATE_ROW' }, revision: 1 } })).status()).toBe(400);
        const share = await request.post(path + '/share', { headers: headers() });
        expect(share.status()).toBe(200);
        const sharedPath = '/api/shared/' + (await share.json()).token;
        expect((await request.get(sharedPath, { headers: headers('none') })).status()).toBe(401);
        const shared = await request.get(sharedPath, { headers: headers('bob') });
        expect(shared.status()).toBe(200);
        expect((await shared.json()).readOnly).toBe(true);
        copy = await create(request, (await shared.json()).state, 'bob');
        expect((await request.get('/api/analyses/' + copy.id, { headers: headers('alice') })).status()).toBe(404);
        expect((await request.delete(path + '/share', { headers: headers() })).status()).toBe(200);
        expect((await request.get(sharedPath, { headers: headers('bob') })).status()).toBe(404);
    } finally {
        await remove(request, doc.id);
        if (copy) await remove(request, copy.id, 'bob');
    }
});

test('real browser tabs restore independent WFS analyses, map views and filters and reject stale saves', async ({ request, context, page }) => {
    const alpha = await create(request, wfsState(7)), beta = await create(request, wfsState(11));
    try {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'My analyses' })).toBeVisible();
        await expect(page.getByRole('heading', { name: alpha.name, exact: true })).toBeVisible();
        const other = await context.newPage();
        await page.goto('/?analysis=' + alpha.id);
        await other.goto('/?analysis=' + beta.id);
        await expect(page.locator('#hud')).toHaveText('Loaded 7 points');
        await expect(other.locator('#hud')).toHaveText('Loaded 11 points');
        await page.locator('#addRule').click();
        await page.getByLabel('Attribute', { exact: true }).selectOption('id');
        await page.getByLabel('Operator', { exact: true }).selectOption('gte');
        await page.getByLabel('Filter value', { exact: true }).fill('3');
        await page.locator('#apply').click();
        await expect(page.locator('#filterStatus')).toContainText('4 matches');
        await page.evaluate(() => (window as any).__WFS_MAP__.map.jumpTo({ center: [-1, 54], zoom: 8 }));
        await save(page);
        await expect(other.locator('#filterStatus')).toContainText('11 matches');
        const betaSaved = await (await request.get('/api/analyses/' + beta.id)).json();
        expect(betaSaved.state.analyses).toEqual([]);
        await page.reload();
        await expect(page.locator('#filterStatus')).toContainText('4 matches');
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.map.getZoom())).toBe(8);
        const stale = await context.newPage();
        await stale.goto('/?analysis=' + alpha.id);
        await expect(stale.locator('#filterStatus')).toContainText('4 matches');
        await page.getByLabel('Analysis name', { exact: true }).fill('Updated alpha');
        await save(page);
        await stale.getByRole('button', { name: 'Save analysis', exact: true }).click();
        await expect(stale.locator('.saved-analysis-bar')).toContainText('newer version');
        expect((await (await request.get('/api/analyses/' + alpha.id)).json()).name).toBe('Updated alpha');
        await other.reload();
        await expect(other.locator('#hud')).toHaveText('Loaded 11 points');
    } finally {
        await remove(request, alpha.id); await remove(request, beta.id);
    }
});

test('CSV files stay local and isolated across users in one browser; shared attachments and personal copies reload', async ({ request, context, page, baseURL }) => {
    const state = configurationState({ sources: [{ id: 'csv', name: 'Local stations', enabled: true, config: { ...defaultConfig, type: 'csv', csvRef: 'missing-' + randomUUID(), fileName: 'stations.csv', longitudeField: 'lon', latitudeField: 'lat' } }], background: { url: '', attribution: '', enabled: false } }, { choice: 'all', bounds: {} }, []);
    const doc = await create(request, state);
    let copyID: string | undefined;
    const payloads: string[] = [];
    context.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/') && req.postData()) payloads.push(req.postData()!); });
    try {
        await page.goto('/?analysis=' + doc.id);
        await expect(page.locator('#status')).toContainText('file is missing');
        await attach(page, 'lon,lat,value,secret\n-1,54,7,ALICE_PRIVATE_ROW\n-2,53,9,ALICE_PRIVATE_ROW');
        await expect(page.locator('#hud')).toHaveText('Loaded 2 points');
        await save(page);
        await page.getByRole('button', { name: 'Share', exact: true }).click();
        await expect(page.getByLabel('Shared analysis link')).toBeVisible();
        const sharedURL = new URL(await page.getByLabel('Shared analysis link').inputValue());
        const owner = await (await request.get('/api/analyses/' + doc.id, { headers: headers() })).json();
        expect(JSON.stringify(owner)).not.toContain('ALICE_PRIVATE_ROW');
        const ownerRef = owner.state.settings.sources[0].config.csvRef;
        await user(context, baseURL!, 'bob');
        await page.goto('/?analysis=' + doc.id);
        await expect(page.locator('#app')).toContainText('Analysis not found');
        await page.goto(sharedURL.pathname + sharedURL.search);
        await expect(page.locator('#status')).toContainText('file is missing');
        await expect(page.getByRole('button', { name: 'Save analysis', exact: true })).toHaveCount(0);
        // A copy also cannot pick up the owner's cached reference.
        await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
        await expect(page.getByLabel('Analysis name', { exact: true })).toHaveValue(doc.name + ' (copy)');
        copyID = new URL(page.url()).searchParams.get('analysis')!;
        await expect(page.locator('#status')).toContainText('file is missing');
        await page.goto(sharedURL.pathname + sharedURL.search);
        await attach(page, 'lon,lat,value,secret\n-3,52,8,BOB_PRIVATE_ROW');
        await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
        await page.reload();
        await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
        await remove(request, copyID, 'bob'); copyID = undefined;
        await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
        await expect(page.getByLabel('Analysis name', { exact: true })).toHaveValue(doc.name + ' (copy)');
        copyID = new URL(page.url()).searchParams.get('analysis')!;
        await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
        await page.reload();
        await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
        const unchangedOwner = await (await request.get('/api/analyses/' + doc.id, { headers: headers() })).json();
        expect(unchangedOwner.state.settings.sources[0].config.csvRef).toBe(ownerRef);
        await user(context, baseURL!, 'alice');
        await page.goto('/?analysis=' + doc.id);
        await expect(page.locator('#hud')).toHaveText('Loaded 2 points');
        for (const payload of payloads) {
            expect(payload).not.toContain('PRIVATE_ROW');
            expect(payload).not.toContain('csvText');
        }
    } finally {
        await remove(request, doc.id);
        if (copyID) await remove(request, copyID, 'bob');
    }
});

test('Save, Share and Save a copy refuse row selections without changing existing filters or remote state', async ({ request, page }) => {
    const doc = await create(request, wfsState(7));
    try {
        await page.goto('/?analysis=' + doc.id);
        await expect(page.locator('#hud')).toHaveText('Loaded 7 points');
        const expr = { op: 'and', children: [{ field: 'id', op: 'gte', value: '3' }, { op: 'or', children: [{ op: 'row', index: 4 }] }] };
        await page.evaluate(expression => {
            const app = (window as any).__WFS_MAP__;
            app.workspace.select(expression, 'Individual observation');
        }, expr);
        await expect(page.locator('#filterStatus')).toContainText('1 matches');
        for (const label of ['Save analysis', 'Share', 'Save a copy']) {
            await page.getByRole('button', { name: label, exact: true }).click();
            await expect(page.locator('.saved-analysis-bar')).toContainText('Individual-observation selections cannot be saved');
            expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children[0])).toEqual(expr);
            expect((await (await request.get('/api/analyses/' + doc.id)).json()).revision).toBe(1);
        }
        await page.locator('#rules .selection button').click();
        const portable = { op: 'and', children: [{ field: 'id', op: 'gte', value: '3' }, { op: 'or', children: [{ field: 'id', op: 'eq', value: '4' }, { field: 'id', op: 'eq', value: '5' }] }] };
        await page.evaluate(expression => (window as any).__WFS_MAP__.workspace.select(expression, 'Portable nested filter'), portable);
        await expect(page.locator('#filterStatus')).toContainText('2 matches');
        await save(page);
        await page.reload();
        await expect(page.locator('#filterStatus')).toContainText('2 matches');
        expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children[0])).toEqual(portable);
    } finally { await remove(request, doc.id); }
});
