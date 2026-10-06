import { navigate } from '../navigation.ts';
import { test, expect, type BrowserContext } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { configurationState, emptyState, type AnalysisDocument } from '../../src/analysis-state.ts';
async function service(context: BrowserContext, initial: AnalysisDocument[] = []) {
    const docs = new Map(initial.map(d => [d.id, structuredClone(d)])); const payloads: string[] = []; let next = 0;
    await context.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.slice(4), method = request.method();
        if (path.startsWith('/test-wfs')) return route.continue();
        const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (path === '/me') return send({ user: 'analyst' });
        if (method === 'GET' && path === '/analyses') return send([...docs.values()].map(({ state, readOnly, ...rest }) => rest));
        if (method === 'POST' && path === '/analyses') {
            payloads.push(request.postData()!); const body = request.postDataJSON();
            const doc = { id: `created-${++next}`, name: body.name, state: body.state, revision: 1, updatedAt: new Date().toISOString(), readOnly: false, shared: false }; docs.set(doc.id, doc); return send(doc);
        }
        const share = path.match(/^\/shared\/(.+)$/);
        if (share) { const doc = docs.get(share[1].replace('token-', '')); return doc ? send({ ...doc, readOnly: true }) : send('Not found', 404); }
        const match = path.match(/^\/analyses\/([^/]+)(\/share)?$/);
        if (!match) return send('Not found', 404);
        const doc = docs.get(match[1]); if (!doc) return send('Not found', 404);
        if (match[2]) { doc.shared = method === 'POST'; return send(method === 'POST' ? { token: 'token-' + doc.id } : { ok: true }); }
        if (method === 'GET') return send(doc);
        if (method === 'PUT') {
            payloads.push(request.postData()!); const body = request.postDataJSON();
            if (body.revision !== doc.revision) return send('Another tab saved a newer version', 409);
            Object.assign(doc, { name: body.name, state: body.state, revision: doc.revision + 1 }); return send(doc);
        }
        if (method === 'DELETE') { docs.delete(doc.id); return send({ ok: true }); }
        return send('Unsupported', 405);
    });
    return { docs, payloads };
}
function document(id: string, points = 7): AnalysisDocument {
    const config = { ...defaultConfig, url: `http://127.0.0.1:8787/wfs?points=${points}`, layer: 'demo:points' };
    return { id, name: `Analysis ${id}`, revision: 1, updatedAt: new Date().toISOString(), readOnly: false, shared: false,
        state: configurationState({ sources: [{ id: 'source-' + id, name: 'Source ' + id, enabled: true, config }], background: { url: '', attribution: '', enabled: false } }, { choice: 'all', bounds: {} }, []) };
}
test('landing selector creates named analyses and opens the configured data sources page', async ({ context, page }) => {
    const db = await service(context, [document('alpha')]); await page.goto('/');
    await expect(page.getByRole('heading', { name: 'My analyses' })).toBeVisible();
    await page.getByRole('link', { name: 'Data sources', exact: true }).click();
    await expect(page.locator('#configuration')).toBeVisible(); await expect(page.locator('#sourceList')).toContainText('Source alpha');
    await navigate(page, 'configuration'); await page.getByRole('link', { name: 'All analyses', exact: true }).click();
    await page.getByLabel('New analysis name').fill('Morning review'); await page.getByRole('button', { name: 'Create analysis' }).click();
    await expect(page.getByLabel('Analysis name', { exact: true })).toHaveValue('Morning review');
    expect(db.docs.get('created-1')?.state.settings.sources).toHaveLength(0);
});
test('different tabs keep separate analyses and saves detect concurrent edits of the same analysis', async ({ context, page }) => {
    const db = await service(context, [document('alpha', 7), document('beta', 11)]);
    const other = await context.newPage(); await page.goto('/?analysis=alpha'); await other.goto('/?analysis=beta');
    await expect(page.locator('#hud')).toHaveText('Loaded 7 points'); await expect(other.locator('#hud')).toHaveText('Loaded 11 points');
    await navigate(page, 'configuration'); await page.getByLabel('Analysis name', { exact: true }).fill('Changed alpha'); await page.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save analysis', exact: true }).click();
    await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved');
    await expect(other.getByLabel('Analysis name', { exact: true })).toHaveValue('Analysis beta');
    await other.reload(); await expect(other.locator('#hud')).toHaveText('Loaded 11 points');
    expect(db.docs.get('beta')?.state.settings.sources[0].name).toBe('Source beta');
    const stale = await context.newPage(); await stale.goto('/?analysis=alpha'); await expect(stale.locator('#hud')).toHaveText('Loaded 7 points');
    await navigate(page, 'configuration'); await page.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save analysis', exact: true }).click(); await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved');
    await navigate(stale, 'configuration'); await stale.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save analysis', exact: true }).click(); await expect(stale.locator('.saved-analysis-bar')).toContainText('newer version');
});
test('CSV attachment and saved filters/charts round-trip locally without sending rows to the server', async ({ context, page }) => {
    const doc = document('csv'); doc.state.settings.sources = [{ id: 'csv-source', name: 'Local stations', enabled: true, config: { ...defaultConfig, type: 'csv', csvRef: 'remote-reference', fileName: 'stations.csv', longitudeField: 'lon', latitudeField: 'lat' } }];
    doc.state.analyses = [{ id: 'csv-source', fields: [{ name: 'value', kind: 'number' }], expression: { op: 'and', children: [{ field: 'value', op: 'gte', value: '8' }] }, charts: [{ id: 'saved-chart', type: 'bar', x: 'value', bins: 8 }] }];
    const db = await service(context, [doc]); await page.goto('/?analysis=csv');
    await expect(page.locator('#status')).toContainText('file is missing');
    await navigate(page, 'configuration'); await page.getByRole('button', { name: 'Configure Local stations', exact: true }).click();
    await page.locator('#csvFile').setInputFiles({ name: 'wrong.csv', mimeType: 'text/csv', buffer: Buffer.from('other,value\n1,9') });
    await expect(page.locator('#sourceError')).toContainText('missing configured columns');
    await page.locator('#csvFile').setInputFiles({ name: 'stations.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,value,secret\n-1,54,7,SENSITIVE_ROW_A\n-2,53,9,SENSITIVE_ROW_B') });
    await expect(page.locator('#csvFileStatus')).toContainText('4 columns'); await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await navigate(page, 'analysis'); await expect(page.locator('#filterStatus')).toContainText('1 matches');
    await expect(page.locator('.chart-card')).toHaveCount(1);
    await navigate(page, 'configuration'); await page.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save analysis', exact: true }).click(); await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved');
    await page.reload(); await expect(page.locator('#filterStatus')).toContainText('1 matches'); await expect(page.locator('.chart-card')).toHaveCount(1);
    await navigate(page, 'configuration'); await page.getByRole('button', { name: 'Share', exact: true }).click(); await expect(page.getByLabel('Shared analysis link')).toBeVisible();
    expect(db.payloads.length).toBeGreaterThan(0);
    for (const payload of db.payloads) { expect(payload).not.toContain('SENSITIVE_ROW'); expect(payload).not.toContain('csvText'); expect(payload).not.toContain('metrics'); expect(payload).not.toContain('results'); }
});
test('a shared setup can attach a local CSV and retain that binding on reload before saving a personal copy', async ({ context, page }) => {
    const doc = document('shared'); doc.state.settings.sources = [{ id: 'csv-source', name: 'Shared CSV', enabled: true, config: { ...defaultConfig, type: 'csv', csvRef: 'remote-reference', fileName: 'stations.csv', longitudeField: 'lon', latitudeField: 'lat' } }];
    const db = await service(context, [doc]); await page.goto('/?share=token-shared');
    await expect(page.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save analysis', exact: true })).toHaveCount(0);
    await navigate(page, 'configuration'); await page.getByRole('button', { name: 'Configure Shared CSV', exact: true }).click();
    await page.locator('#csvFile').setInputFiles({ name: 'stations.csv', mimeType: 'text/csv', buffer: Buffer.from('lon,lat,value\n-1,54,9') });
    await expect(page.locator('#csvFileStatus')).toContainText('3 columns'); await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await navigate(page, 'analysis'); await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
    await page.reload(); await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
    expect(db.docs.get('shared')?.state.settings.sources[0].config.csvRef).toBe('remote-reference');
    await navigate(page, 'configuration'); await page.locator('#remoteAnalysisControls').getByRole('button', { name: 'Save a copy', exact: true }).click(); await expect(page.getByLabel('Analysis name', { exact: true })).toHaveValue('Analysis shared (copy)'); await expect(page.locator('#hud')).toHaveText('Loaded 1 points');
});

test('local and remote saves share one Configuration card and remote saving rejects unapplied source changes', async ({ context, page }) => {
 const db=await service(context,[document('save-layout')]); await page.goto('/?analysis=save-layout');
 await expect(page.locator('.topbar .saved-analysis-bar')).toHaveCount(0);
 await expect(page.getByRole('link',{name:'All analyses',exact:true})).toBeHidden();
 await expect(page.locator('#remoteAnalysisControls').getByRole('button',{name:'Save analysis',exact:true})).toBeHidden();
 await navigate(page,'configuration');
 await expect(page.locator('#analysisSave')).toContainText('Save locally'); await expect(page.locator('#analysisSave')).toContainText('Save remotely & share');
 await expect(page.locator('#analysisSave #saveSettings')).toBeVisible();
 await expect(page.locator('#analysisSave .saved-analysis-bar')).toBeVisible();
 await page.getByRole('button',{name:'Configure Source save-layout',exact:true}).click();
 await page.locator('#sourceName').fill('Revised source'); await page.locator('#updateSource').click();
 await page.locator('#remoteAnalysisControls').getByRole('button',{name:'Save analysis',exact:true}).click();
 await expect(page.locator('.saved-analysis-bar')).toContainText('Save or discard your local source changes');
 expect(db.payloads).toHaveLength(0);
 await page.locator('#saveSettings').click(); await expect(page.locator('#saveState')).toContainText('Saved in this browser');
 await page.locator('#remoteAnalysisControls').getByRole('button',{name:'Save analysis',exact:true}).click();
 await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved');
 expect(db.docs.get('save-layout')?.state.settings.sources[0].name).toBe('Revised source');
});

test('dock save tracks edits, retries failures, and preserves edits made during a pending save', async ({ context, page }) => {
    const db = await service(context, [document('dock')]);
    await page.goto('/?analysis=dock'); await expect(page.locator('#hud')).toHaveText('Loaded 7 points');
    const save = page.locator('#dockSaveAnalysis'); await expect(save).toBeEnabled();
    await save.click(); await expect(save).toBeDisabled();
    await page.locator('.chart-card').nth(2).getByRole('button', { name: 'Settings', exact: true }).click();
    const size = page.locator('.chart-card').nth(2).getByLabel('Point size', { exact: true });
    await size.fill('5'); await expect(save).toBeEnabled();
    await page.route('**/api/analyses/dock', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: 'Save unavailable' }) : route.fallback());
    await save.click(); await expect(page.locator('.dock-save-status')).toContainText('Save unavailable'); await expect(save).toBeEnabled();
    await page.unroute('**/api/analyses/dock');
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/analyses/dock', async route => { if (route.request().method() === 'PUT') await pending; await route.fallback(); });
    await save.click(); await expect(save).toBeDisabled();
    await size.fill('7'); release();
    await expect(page.locator('.saved-analysis-bar')).toContainText('Analysis configuration saved'); await expect(save).toBeEnabled();
    expect(db.docs.get('dock')?.state.analyses[0].charts.find(c => c.type === 'scatter')?.pointSize).toBe(5);
    await save.click(); await expect(save).toBeDisabled();
    await page.locator('#toggleTimeline').click(); await page.locator('.timeline-toggle').check(); await expect(save).toBeEnabled();
    await save.click(); await expect(save).toBeDisabled(); expect(db.docs.get('dock')?.state.timeline).toBeDefined();
    await page.reload(); await expect(page.locator('#hud')).toHaveText('Loaded 7 points');
    await page.locator('#toggleTimeline').click(); await expect(page.locator('.timeline-toggle')).toBeChecked();
    await navigate(page, 'configuration'); await page.getByLabel('Analysis name', { exact: true }).fill('New name'); await expect(save).toBeEnabled();
});
