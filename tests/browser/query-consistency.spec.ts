import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { defaultConfig } from '../../src/source-settings.ts';
import { emptyState, type AnalysisDocument } from '../../src/analysis-state.ts';
import { parseCSV } from '../../src/csv.ts';
import { feature } from '../../server/demo.ts';

const base = { op: 'and', children: [
    { op: 'or', children: [{ field: 'category', op: 'eq', value: 'sensor' }, { field: 'category', op: 'eq', value: 'vehicle' }] },
    { field: 'quality', op: 'gte', value: '50' }
] };
async function ready(page: Page) {
    await page.goto('/?time=all&points=32&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0].done && !(window as any).__WFS_MAP__.sources[0].filtering);
}
async function csvIds(page: Page) {
    const pending = page.waitForEvent('download'); await page.locator('#exportCSV').click();
    const download = await pending;
    return parseCSV(await readFile((await download.path())!, 'utf8')).rows.map(r => r[0]);
}
async function members(page: Page) {
    return page.evaluate(() => {
        const s = (window as any).__WFS_MAP__.sources[0];
        return { rows: s.layer.indices ? [...s.layer.indices] : Array.from({ length: s.loaded }, (_, i) => i), applied: s.workspace.query.applied, counts: s.workspace.results.map((r: any) => [...r.counts].reduce((a: number, b: number) => a + b, 0) + r.missing) };
    });
}

test('edits, chart settings, selections, removal, clear and reload keep results on the applied query', async ({ page }) => {
    await ready(page);
    await page.evaluate(e => (window as any).__WFS_MAP__.filter(e), base);
    const applied = await members(page);
    expect(applied.rows).toEqual(Array.from({ length: 32 }, (_, i) => i).filter(i => ['sensor', 'vehicle'].includes(feature(i).properties.category) && feature(i).properties.quality >= 50));
    const rule = page.locator('#rules > .filter-group > .group-children > .rule');
    await rule.getByLabel('Filter value').fill('90');
    await expect(page.locator('#draftStatus')).toContainText('Unapplied changes');
    const chart = page.locator('.chart-card').first();
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    await chart.getByLabel('Chart type').selectOption('pie');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.workspace.results[0].type === 'pie' && !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(applied);
    expect(await csvIds(page)).toEqual(applied.rows.map(i => feature(i).id));
    await rule.getByRole('button', { name: '×', exact: true }).click();
    expect(await members(page)).toEqual(applied);
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'id', op: 'eq', value: '1' }, 'One record'));
    expect(await members(page)).toEqual(applied);
    await page.locator('#load').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0].done && !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(applied);
    await expect(page.locator('#draftStatus')).toContainText('Unapplied changes');
    await page.locator('#discardFilters').click();
    await expect(page.locator('#draftStatus')).toBeEmpty();
    await page.locator('#reset').click();
    expect(await members(page)).toEqual(applied);
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('32 matches');
    expect((await members(page)).counts).toEqual([32, 32, 32]);
    await page.locator('#undoFilters').click();
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(applied);
    await page.locator('#redoFilters').click();
    await expect(page.locator('#filterStatus')).toContainText('32 matches');
    await page.screenshot({ path: '/tmp/wfs33-query.png', fullPage: true });
});

test('failed applications retain the applied map, charts, export and history', async ({ page }) => {
    await ready(page); await page.evaluate(e => (window as any).__WFS_MAP__.filter(e), base);
    const applied = await members(page);
    await page.locator('#rules > .filter-group > .group-children > .rule').getByLabel('Filter value').fill('invalid number');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('Filter error:');
    expect(await members(page)).toEqual(applied);
    expect(await csvIds(page)).toEqual(applied.rows.map(i => feature(i).id));
    await page.locator('#discardFilters').click();
    await page.locator('#undoFilters').click(); await expect(page.locator('#filterStatus')).toContainText('32 matches');
    await page.locator('#redoFilters').click();
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(applied);
});

for (const action of ['Save analysis', 'Save a copy', 'Share']) test(`${action} resolves drafts explicitly and saves only successfully applied expressions`, async ({ page }) => {
    const state = emptyState(); state.query = { choice: 'all', bounds: {} };
    state.settings.sources = ['a', 'b'].map(id => ({ id, name: id, enabled: true, config: { ...defaultConfig, url: '/wfs?points=32', layer: 'demo:points' } }));
    let doc: AnalysisDocument = { id: 'test', name: 'Query consistency', state, revision: 1, updatedAt: '2026-10-04T22:00:00Z', readOnly: false, shared: false };
    const writes: any[] = [];
    await page.route('**/api/me', route => route.fulfill({ json: { user: 'tester' } }));
    await page.route('**/api/analyses**', async route => {
        if (route.request().url().endsWith('/share')) { await route.fulfill({ json: { token: 'token' } }); return; }
        if (route.request().method() !== 'GET') {
            const body = route.request().postDataJSON(); writes.push(body);
            doc = { ...doc, state: body.state, revision: doc.revision + 1 };
        }
        await route.fulfill({ json: doc });
    });
    await page.goto('/?analysis=test');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
    await page.evaluate(e => (window as any).__WFS_MAP__.filterSource('a', e), base);
    await page.evaluate(() => (window as any).__WFS_MAP__.sources[1].workspace.select({ field: 'category', op: 'eq', value: 'station' }, 'Stations'));
    await page.locator('#rules > .filter-group > .group-children > .rule').getByLabel('Filter value').fill('90');
    await page.getByRole('button', { name: action, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve unapplied filters' });
    await expect(dialog).toContainText('a, b');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.saved-analysis-bar')).toContainText('Save cancelled'); expect(writes).toHaveLength(0);
    if (action === 'Save analysis') {
        const value = page.locator('#rules > .filter-group > .group-children > .rule').getByLabel('Filter value');
        await value.fill('invalid number');
        await page.getByRole('button', { name: action, exact: true }).click();
        await dialog.getByRole('button', { name: 'Apply and continue', exact: true }).click();
        await expect(page.locator('.saved-analysis-bar')).toContainText('could not be applied');
        expect(writes).toHaveLength(0);
        await value.fill('90');
    }
    await page.getByRole('button', { name: action, exact: true }).click();
    const appliedNavigation = action === 'Save a copy' ? page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }) : undefined;
    await dialog.getByRole('button', { name: 'Apply and continue', exact: true }).click();
    await appliedNavigation;
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].state.analyses[0].expression.children[1].value).toBe('90');
    expect(writes[0].state.analyses[1].expression).toEqual({ op: 'and', children: [{ field: 'category', op: 'eq', value: 'station' }] });
    // Copy navigates to the new saved document; all flows must reopen identically.
    await page.goto('/?analysis=test');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
    expect((await members(page)).applied).toEqual(writes[0].state.analyses[0].expression);
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.clearFilters());
    await page.getByRole('button', { name: action, exact: true }).click();
    const discardedNavigation = action === 'Save a copy' ? page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }) : undefined;
    await dialog.getByRole('button', { name: 'Discard edits and continue', exact: true }).click();
    await discardedNavigation;
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].state.analyses).toEqual(writes[0].state.analyses);
});

test('undo and redo preserve nested queries without changing another source or its draft', async ({ page }) => {
    await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({ sources: ['a', 'b'].map(id => ({ id, name: id, enabled: true, config: { ...config, url: '/wfs?points=32', layer: 'demo:points' } })) })), defaultConfig);
    await page.goto('/?time=all'); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s: any) => s.done && !s.filtering));
    await page.evaluate(e => (window as any).__WFS_MAP__.filterSource('a', e), base);
    await page.evaluate(() => (window as any).__WFS_MAP__.filterSource('b', [{ field: 'id', op: 'eq', value: '1' }]));
    const before = await members(page);
    await page.evaluate(() => (window as any).__WFS_MAP__.sources[1].workspace.select({ field: 'category', op: 'eq', value: 'sensor' }, 'Draft'));
    await page.locator('#undoFilters').click(); await expect(page.locator('#filterStatus')).toContainText('32 matches');
    await page.locator('#redoFilters').click(); await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(before);
    expect(await page.evaluate(() => ({ count: (window as any).__WFS_MAP__.sources[1].selected, dirty: (window as any).__WFS_MAP__.sources[1].workspace.unapplied }))).toEqual({ count: 1, dirty: true });
});

test('chart recalculation preserves an Apply in flight and keeps later edits as drafts', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
        const s = (window as any).__WFS_MAP__.sources[0], post = s.worker.postMessage.bind(s.worker);
        const queued: any[] = [];
        s.worker.postMessage = (m: any) => m.type === 'analyze' ? queued.push(m) : post(m);
        (window as any).__releaseQuery = () => { s.worker.postMessage = post; post(queued.at(-1)); };
    });
    await page.evaluate(e => { void (window as any).__WFS_MAP__.filter(e); }, base);
    const chart = page.locator('.chart-card').first();
    await chart.getByRole('button', { name: 'Settings', exact: true }).click();
    await chart.getByLabel('Chart type').selectOption('pie');
    await page.locator('#rules > .filter-group > .group-children > .rule').getByLabel('Filter value').fill('90');
    await page.evaluate(() => (window as any).__releaseQuery());
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    expect((await members(page)).applied).toEqual(base);
    await expect(page.locator('#draftStatus')).toContainText('Unapplied changes');
    const applied = await members(page);
    expect(await csvIds(page)).toEqual(applied.rows.map(i => feature(i).id));
    await page.locator('#discardFilters').click();
    await page.locator('#undoFilters').click(); await expect(page.locator('#filterStatus')).toContainText('32 matches');
    await page.locator('#redoFilters').click();
    await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
    expect(await members(page)).toEqual(applied);
});
