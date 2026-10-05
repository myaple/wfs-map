import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { navigate, openFilters, openTimeline } from '../navigation.ts';

test('two hover menus route four pages; shared bottom panels start collapsed and retain controls across all pages', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({sources:[{id:'a',name:'North observations',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',timeField:'day',csvText:'lon,lat,uuid,value,day\n-1,54,A,1,2025-01-01\n-2,53,B,2,2025-01-02'}},{id:'b',name:'Survey results',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',csvText:'lon,lat,uuid,value\n0,55,A,5\n0,55,B,6'}}]})),defaultConfig);
 await page.goto('/?time=all#analysis'); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s:any)=>s.done&&!s.filtering));
 await expect(page.locator('#workspaceNavigation > .page-menu > button')).toHaveText(['Analysis','Data sources']);
 await expect(page.locator('#recordsLink')).toBeHidden(); await page.locator('#analysisMenu').hover();
 await expect(page.locator('#analysisMenuPages a')).toHaveText(['Dashboard','Records']);
 await page.locator('#recordsLink').click(); await expect(page.locator('#records')).toBeVisible();
 await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','false'); await expect(page.locator('#workspaceFilters .query-panel')).toBeHidden();
 await expect(page.locator('#records #derivedDatasets')).toHaveCount(0);
 await page.locator('#toggleFilters').click();
 await page.locator('#rules > .filter-group > .group-head').getByRole('button',{name:'+ Rule',exact:true}).click();
 const rule=page.locator('#rules .rule'); await rule.getByLabel('Attribute',{exact:true}).selectOption('value'); await rule.getByLabel('Operator',{exact:true}).selectOption('gte'); await rule.getByLabel('Filter value',{exact:true}).fill('2'); await page.locator('#apply').click();
 await expect(page.locator('#records > [role=status]')).toContainText('1 table rows');
 await page.locator('#dataSourcesMenu').hover(); await expect(page.locator('#dataSourcesMenuPages a')).toHaveText(['Configuration','Derived datasets']);
 await page.locator('#derivedLink').click(); await expect(page.locator('#derived')).toBeVisible();
 await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','true'); await expect(page.locator('#workspaceFilters .filter-panel')).toBeVisible();
 await expect(page.locator('#derivedDatasets')).toBeVisible();
 await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2'); await expect(page.locator('#filterStatus')).toContainText('1 matches');
 await page.getByLabel('Left match field',{exact:true}).selectOption('uuid'); await page.getByLabel('Right match field',{exact:true}).selectOption('uuid');
 await page.getByLabel('Input rows',{exact:true}).selectOption('applied'); await page.getByRole('button',{name:'Preview join',exact:true}).click();
 await expect(page.locator('#joinStatus')).toContainText('1 output rows'); await expect(page.locator('.join-sample')).toContainText('North observations.value'); await expect(page.locator('.join-sample')).toContainText('Survey results.value');
 await navigate(page,'analysis'); await expect(page.locator('#analysis')).toBeVisible(); await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2');
 await expect(page.locator('#queryTitle')).toBeVisible(); await expect(page.locator('#rules')).toHaveCount(1); await expect(page.locator('.timeline')).toHaveCount(1);
 await navigate(page,'records'); await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','true'); await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2');
 await navigate(page,'configuration'); await expect(page.locator('#configuration')).toBeVisible(); await expect(page.locator('#derived')).toBeHidden();
 expect(errors).toEqual([]);
});

test('page menus support keyboard, Escape and narrow touch navigation', async ({ browser }) => {
 const context = await browser.newContext({viewport:{width:375,height:700},hasTouch:true}); const page=await context.newPage();
 await page.goto('/?local=1#analysis');
 await page.locator('#analysisMenu').tap(); await expect(page.locator('#recordsLink')).toBeVisible(); await page.locator('#recordsLink').tap();
 await expect(page.locator('#records')).toBeVisible(); await expect(page.locator('#analysisMenu')).toHaveClass(/current/);
 await page.locator('#dataSourcesMenu').tap(); await page.locator('#derivedLink').tap(); await expect(page.locator('#derived')).toBeVisible();
 await expect(page.locator('#dataSourcesMenu')).toHaveClass(/current/);
 expect(await page.locator('#derived').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 await page.locator('#analysisMenu').focus(); await page.keyboard.press('ArrowDown'); await expect(page.locator('#analysisLink')).toBeFocused();
 await page.keyboard.press('ArrowDown'); await expect(page.locator('#recordsLink')).toBeFocused();
 await page.keyboard.press('Escape'); await expect(page.locator('#analysisMenu')).toBeFocused(); await expect(page.locator('#recordsLink')).toBeHidden();
 await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(page.locator('#analysis')).toBeVisible();
 await context.close();
});

test('Derived datasets deep links load directly and browser history restores subpages', async ({page})=>{
 await page.goto('/#derived'); await expect(page.locator('#derivedDatasets')).toBeVisible(); await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','false');
 await navigate(page,'records'); await expect(page.locator('#records')).toBeVisible(); await page.goBack(); await expect(page.locator('#derived')).toBeVisible();
 await page.reload(); await expect(page.locator('#derivedDatasets')).toBeVisible(); await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','false');
});

test('bottom panels stack independently, preserve selection, and fit narrow screens and banners', async ({ page }) => {
 await page.route('**/api/site-config', route => route.fulfill({json:{bannerText:'Analysis workspace',bannerBackground:'#ccddee'}}));
 await page.goto('/?time=all&points=32&autoload=1');
 await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources[0]?.done);
 await expect(page.locator('#toggleFilters')).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('#toggleTimeline')).toHaveAttribute('aria-expanded','false');
 const mapWidth = (await page.locator('#map').boundingBox())!.width;
 await openFilters(page); await openTimeline(page);
 expect((await page.locator('#map').boundingBox())!.width).toBe(mapWidth);
 const filterBox=(await page.locator('#workspaceFilters').boundingBox())!, timelineBox=(await page.locator('.timeline-body').boundingBox())!;
 expect(filterBox.y+filterBox.height).toBeLessThanOrEqual(timelineBox.y);
 expect(filterBox.height).toBeGreaterThan(100); expect(timelineBox.height).toBeGreaterThan(100);
 const filterTab=(await page.locator('#toggleFilters').boundingBox())!, timelineTab=(await page.locator('#toggleTimeline').boundingBox())!;
 expect(filterTab.y).toBe(timelineTab.y);
 for (const enlarge of [page.locator('#enlargeMap'), page.locator('.chart-card').first().getByRole('button',{name:'Enlarge',exact:true})]) {
  await enlarge.click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.locator('#workspaceFilters')).toBeVisible(); await expect(dialog.locator('.timeline-body')).toBeVisible();
  const filters=(await dialog.locator('#workspaceFilters').boundingBox())!, timeline=(await dialog.locator('.timeline-body').boundingBox())!;
  expect(filters.height).toBeGreaterThan(100); expect(timeline.height).toBeGreaterThan(100);
  expect(filters.y+filters.height).toBeLessThanOrEqual(timeline.y);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.locator('#app > #workspaceDock #workspaceFilters')).toBeVisible(); await expect(page.locator('#app > #workspaceDock .timeline-body')).toBeVisible();
 }
 const colour=(await page.locator('.dashboard-footer > .colour-panel').first().boundingBox())!, csv=(await page.locator('.csv-export-panel').boundingBox())!;
 expect(colour.x+colour.width).toBeLessThanOrEqual(csv.x);
 expect(colour.y).toBeGreaterThan((await page.locator('.analysis-grid').boundingBox())!.y);
 await page.getByLabel('Use time window').check();
 await page.getByRole('slider',{name:'Timeline start handle',exact:true}).focus(); await page.keyboard.press('ArrowRight');
 await expect.poll(() => page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(31);
 await page.waitForFunction(() => !(window as any).__WFS_MAP__.sources[0].filtering);
 const count = await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected);
 await page.locator('#toggleTimeline').click(); await page.locator('#toggleFilters').click();
 await expect(page.locator('.timeline-body')).toBeHidden();
 await openFilters(page); await expect(page.locator('.timeline-body')).toBeHidden();
 await openTimeline(page); await page.locator('#toggleFilters').click();
 await expect(page.locator('#workspaceFilters')).toBeHidden(); await expect(page.locator('.timeline-body')).toBeVisible();
 await page.locator('#toggleTimeline').click();
 for (const target of ['records','derived','configuration','analysis'] as const) {
  await navigate(page,target); await expect(page.locator('#toggleFilters')).toBeVisible(); await expect(page.locator('#toggleTimeline')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources[0].selected)).toBe(count);
 }
 await page.setViewportSize({width:375,height:700}); await openFilters(page); await openTimeline(page);
 for (const selector of ['#workspaceFilters','.query-panel','.filter-panel','.timeline']) {
  expect(await page.locator(selector).evaluate(e => {const r=e.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && e.scrollWidth<=e.clientWidth;})).toBe(true);
 }
 const bottom=(await page.locator('.timeline').boundingBox())!, banner=(await page.locator('#page-footer').boundingBox())!;
 expect(bottom.y+bottom.height).toBeLessThanOrEqual(banner.y);
 await page.locator('#filterSource').focus(); await page.keyboard.press('Escape');
 await expect(page.locator('#toggleFilters')).toBeFocused(); await expect(page.locator('#workspaceFilterContent')).toBeHidden();
 await expect(page.locator('.timeline-body')).toBeVisible();
 await page.locator('#toggleTimeline').click();
 await page.screenshot({path:'test-results/workspace-docks-mobile.png'});
});
