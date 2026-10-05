import { navigate, openFilters } from '../navigation.ts';
import { test, expect } from '@playwright/test';
import { feature } from '../../server/demo.ts';
const ready = async (page: any) => { await page.goto('/?time=all&points=4096&autoload=1'); await openFilters(page); await page.waitForFunction(() => (window as any).__WFS_MAP__?.metrics.analysisCharts?.length === 3); for (const toggle of await page.getByRole('button', { name: 'Settings', exact: true }).all()) await toggle.click(); };
test('filter groups collapse independently and retain applied rules and chart selections', async ({ page }) => {
    await ready(page);
    await expect(page.locator('.filter-actions button')).toHaveText(['Apply filters', 'Clear filters']);
    const root = page.locator('#rules > .filter-group');
    const rootHead = root.locator(':scope > .group-head');
    await rootHead.getByRole('button', { name: '+ Group', exact: true }).click();
    const nested = root.locator(':scope > .group-children > .filter-group');
    const nestedHead = nested.locator(':scope > .group-head');
    await nestedHead.getByRole('button', { name: '+ Rule', exact: true }).click();
    await nested.getByLabel('Attribute').selectOption('category');
    await nested.getByLabel('Filter value').fill('sensor');
    const expression = await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression());
    await nestedHead.getByRole('button', { name: 'Collapse filter group', exact: true }).click();
    await expect(nestedHead.getByRole('button', { name: 'Expand filter group', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(nested.getByLabel('Filter value')).toBeHidden();
    await expect(nestedHead.locator('.group-count')).toHaveText('1 rule');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression())).toEqual(expression);
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'value', op: 'gt', value: '1' }, 'Value'));
    await expect(nestedHead.locator('.group-count')).toHaveText('2 rules');
    await rootHead.getByRole('button', { name: 'Collapse filter group', exact: true }).click();
    await rootHead.getByRole('button', { name: 'Expand filter group', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(nested.getByLabel('Filter value').first()).toBeHidden();
    await nestedHead.getByRole('button', { name: 'Expand filter group', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(nested.getByLabel('Filter value').first()).toHaveValue('sensor');
    await expect(nested.getByLabel('Filter value').last()).toHaveValue('1');
    await nested.locator('.rule').last().getByRole('button', { name: '×', exact: true }).click();
    await expect(rootHead.locator('.group-count')).toHaveText('1 rule');
    await rootHead.getByRole('button', { name: 'Collapse filter group', exact: true }).click();
    await page.locator('#reset').click();
    await expect(page.locator('#filterStatus')).toContainText('4,096 matches');
    await expect(rootHead.locator('.group-count')).toHaveText('0 rules');
    await expect(rootHead.getByRole('button', { name: 'Collapse filter group', exact: true })).toHaveAttribute('aria-expanded', 'true');
});
test('configuration is a subpage and navigation retains selection and chart state', async ({ page }) => {
    await ready(page);
    await expect(page.locator('#url')).toBeHidden();
    await expect(page.locator('.chart-card')).toHaveCount(3);
    await navigate(page, 'configuration');
    await expect(page.locator('#url')).toBeHidden();
    await page.getByRole('button', { name: 'Configure WFS source', exact: true }).click();
    await expect(page.locator('#url')).toBeVisible();
    await page.locator('#cancelSource').click();
    await expect(page.locator('#analysis')).toBeHidden();
    await navigate(page, 'analysis');
    await expect(page.locator('.chart-card')).toHaveCount(3);
    await expect(page.locator('#filterStatus')).toContainText('4,096 matches');
});
test('chart clicks cross-filter all charts, OR selections combine, and removing a condition restores the dataset', async ({ page }) => {
    await ready(page);
    const first = page.locator('.chart-card').first();
    await first.locator('details summary').click();
    await first.getByRole('button', { name: 'category: sensor · 1,024', exact: true }).click();
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
    await page.locator('#rules > .filter-group > .group-head > select').selectOption('or');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
    await first.getByRole('button', { name: 'category: vehicle · 0', exact: true }).click();
    await expect(page.locator('#filterStatus')).toContainText('2,048 matches');
    const counts = await page.evaluate(() => (window as any).__WFS_MAP__.workspace.results.map((r: any) => r.counts.reduce((a: number, b: number) => a + b, 0) + r.missing));
    expect(counts).toEqual([2048, 2048, 2048]);
    await page.locator('#reset').click();
    await expect(page.locator('#filterStatus')).toContainText('4,096 matches');
});
test('all chart types configure from schema and scatter drag produces an exact AND range', async ({ page }) => {
    await ready(page);
    const first = page.locator('.chart-card').first();
    await first.getByLabel('Chart type').selectOption('pie');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.workspace.results[0].type === 'pie');
    const canvas = first.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 60, box.y + 120);
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
    await page.locator('#reset').click();
    await expect(page.locator('#filterStatus')).toContainText('4,096 matches');
    const scatter = page.locator('.chart-card').nth(2);
    await scatter.getByLabel('Binning', { exact: true }).selectOption('8');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.workspace.results[2].counts.length === 64);
    await scatter.locator('canvas').scrollIntoViewIfNeeded();
    const b = (await scatter.locator('canvas').boundingBox())!, rect = JSON.parse((await scatter.locator('canvas').getAttribute('data-plot-rect'))!), dx = (rect.right - rect.left) / 8, dy = (rect.bottom - rect.top) / 8;
    await page.mouse.move(b.x + rect.left + dx * .5, b.y + rect.bottom - dy * .5);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(b.x + rect.left + dx * 2.5, b.y + rect.bottom - dy * 2.5);
    await page.mouse.up({ button: 'right' });
    await expect(page.locator('#filterStatus')).not.toContainText('4,096 matches');
    const result = await page.evaluate(() => (window as any).__WFS_MAP__.workspace.results[2]);
    const bounds = await page.evaluate(() => { const r = (window as any).__WFS_MAP__.workspace.results[2]; return { x: r.x.ranges.slice(0, 4), y: r.y.ranges.slice(0, 4), xf: r.x.field, yf: r.y.field, count: (window as any).__WFS_MAP__.metrics.filterCount }; });
    const expected = Array.from({ length: 4096 }, (_, i) => feature(i)).filter(f => { const p = f.properties as any; return p[bounds.xf] >= bounds.x[0] && p[bounds.xf] < bounds.x[3] && p[bounds.yf] >= bounds.y[0] && p[bounds.yf] < bounds.y[3]; }).length;
    expect(bounds.count).toBe(expected);
    expect(result.type).toBe('scatter');
});
test('nested manual filters, latest request wins, empty result and keyboard selection', async ({ page }) => {
    await ready(page);
    await page.locator('#rules > .filter-group > .group-head').getByRole('button', { name: '+ Group', exact: true }).click();
    const group = page.locator('#rules .filter-group .filter-group');
    await group.getByRole('button', { name: '+ Rule', exact: true }).click();
    await group.getByLabel('Attribute').selectOption('value');
    await group.getByLabel('Operator').selectOption('gte');
    await group.getByLabel('Filter value').fill('50');
    await page.locator('#apply').click();
    const n = Array.from({ length: 4096 }, (_, i) => feature(i)).filter(f => f.properties.value >= 50).length;
    await expect(page.locator('#filterStatus')).toContainText(`${n.toLocaleString()} matches`);
    await page.evaluate(() => { const h = (window as any).__WFS_MAP__; h.filter([{ field: 'id', op: 'eq', value: '1' }]); h.filter([{ field: 'id', op: 'eq', value: '-1' }]); });
    await expect(page.locator('#filterStatus')).toContainText('0 matches');
    await page.locator('#reset').click();
    await expect(page.locator('#filterStatus')).toContainText('4,096 matches');
    await page.locator('.chart-card').first().locator('canvas').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
});


test('chart selections follow the last edited group without a target button', async ({ page }) => {
    await ready(page);
    await expect(page.getByRole('button', { name: 'Add chart selections here' })).toHaveCount(0);
    const rootHead = page.locator('#rules > .filter-group > .group-head');
    await rootHead.getByRole('button', { name: '+ Group', exact: true }).click();
    const nested = page.locator('#rules .filter-group .filter-group');
    await nested.getByLabel('Group logic').focus();
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'eq', value: 'sensor' }, 'Sensors'));
    await expect(nested.locator('.selection')).toHaveCount(1);
    await expect(page.locator('#filterStatus')).toContainText('1,024 matches');
    await rootHead.getByLabel('Group logic').selectOption('or');
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'eq', value: 'vehicle' }, 'Vehicles'));
    await expect(page.locator('#rules > .filter-group > .group-children > .selection')).toHaveCount(1);
    await expect(page.locator('#filterStatus')).toContainText('2,048 matches');
});

test('chart and manual filters use the same editable controls', async ({ page }) => {
    await ready(page);
    const first = page.locator('.chart-card').first();
    await first.locator('details summary').click();
    await first.getByRole('button', { name: 'category: station · 1,024', exact: true }).click();
    const selected = page.locator('#rules .rule').first();
    await expect(selected.getByLabel('Attribute')).toHaveValue('category');
    await expect(selected.getByLabel('Operator')).toHaveValue('eq');
    await expect(selected.getByLabel('Filter value')).toHaveValue('station');
    await page.locator('#rules > .filter-group > .group-head').getByRole('button', { name: '+ Rule', exact: true }).click();
    const manual = page.locator('#rules .rule').last();
    await manual.getByLabel('Attribute').selectOption('value');
    await manual.getByLabel('Operator').selectOption('gt');
    await manual.getByLabel('Filter value').fill('1');
    const geometry = await page.locator('#rules .rule').evaluateAll(rows => rows.map(row => [...row.children].map(control => ({ tag: control.tagName, width: Math.round(control.getBoundingClientRect().width) }))));
    expect(geometry[0]).toEqual(geometry[1]);
    await selected.getByLabel('Filter value').fill('sensor');
    await page.locator('#apply').click();
    const expected = Array.from({ length: 4096 }, (_, i) => feature(i)).filter(f => f.properties.category === 'sensor' && f.properties.value > 1).length;
    await expect(page.locator('#filterStatus')).toContainText(`${expected.toLocaleString()} matches`);
    await selected.getByRole('button', { name: '×', exact: true }).click();
    const remaining = Array.from({ length: 4096 }, (_, i) => feature(i)).filter(f => f.properties.value > 1).length;
    await expect(page.locator('#filterStatus')).toContainText(`${remaining.toLocaleString()} matches`);
});

test('nested chart predicates round-trip through the shared editors and retain the selection target', async ({ page }) => {
    await ready(page);
    const expression = { op: 'or', children: [
        { field: 'category', op: 'eq', value: 'station' },
        { op: 'and', children: [{ field: 'value', op: 'gte', value: '50' }, { field: 'value', op: 'lt', value: '60' }] }
    ] };
    await page.evaluate(expr => (window as any).__WFS_MAP__.workspace.select(expr, 'Chart range'), expression);
    await expect(page.locator('#rules .rule')).toHaveCount(3);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children[0])).toEqual(expression);
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ field: 'category', op: 'ne', value: 'vehicle' }, 'Exclude vehicles'));
    await expect(page.locator('#rules > .filter-group > .group-children > .rule')).toHaveCount(1);
    await page.evaluate(() => { const w = (window as any).__WFS_MAP__.workspace; w.restore(w.expression(), structuredClone(w.specs)); });
    await expect(page.locator('#rules .rule')).toHaveCount(4);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children[0])).toEqual(expression);
    await page.locator('#rules .rule').first().getByLabel('Operator').selectOption('ne');
    await page.locator('#apply').click();
    const expected = Array.from({ length: 4096 }, (_, i) => feature(i)).filter(f => (f.properties.category !== 'station' || (f.properties.value >= 50 && f.properties.value < 60)) && f.properties.category !== 'vehicle').length;
    await expect(page.locator('#filterStatus')).toContainText(`${expected.toLocaleString()} matches`);
});

test('category sets and non-attribute selections keep their exact meaning in compact rows', async ({ page }) => {
    await ready(page);
    const expression = { op: 'and', children: [
        { field: 'category', op: 'notin', values: ['station', 'value, with comma', 'value\nwith newline'] },
        { op: 'bbox', west: -180, south: -90, east: 180, north: 90 }
    ] };
    await page.evaluate(expr => { const w = (window as any).__WFS_MAP__.workspace; w.restore(expr, structuredClone(w.specs)); }, expression);
    await expect(page.locator('#rules .rule')).toHaveCount(2);
    const set = page.locator('#rules .rule').first();
    await expect(set.getByLabel('Operator')).toHaveValue('notin');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression())).toEqual(expression);
    await set.getByLabel('Filter value').fill('invalid list');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('Filter error: Category values');
    await set.getByLabel('Filter value').fill('["station", "sensor"]');
    await page.locator('#apply').click();
    await expect(page.locator('#filterStatus')).toContainText('2,048 matches');
    await page.evaluate(() => { const w = (window as any).__WFS_MAP__.workspace; w.select({ op: 'row', index: 2 }, 'Observation'); w.discardObservationSelections(); });
    await expect(page.locator('#rules .rule')).toHaveCount(2);
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.workspace.expression().children[1])).toEqual(expression.children[1]);
    await page.evaluate(() => (window as any).__WFS_MAP__.workspace.select({ op: 'or', children: [{ op: 'row', index: 2 }] }, 'Observations'));
    await page.locator('#rules .selection > .group-head').getByLabel('Group logic').focus();
    await page.evaluate(() => { const w = (window as any).__WFS_MAP__.workspace; w.discardObservationSelections(); w.select({ field: 'category', op: 'eq', value: 'vehicle' }, 'Vehicles'); });
    await expect(page.locator('#rules .rule')).toHaveCount(3);
    await expect(page.locator('#rules > .filter-group > .group-children > .rule').last().getByLabel('Filter value')).toHaveValue('vehicle');
});
