import { test, expect } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { navigate } from '../navigation.ts';

test('two hover menus route four pages; Records and Derived filters start collapsed and share controls', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript(config => localStorage.setItem('wfs-settings', JSON.stringify({sources:[{id:'a',name:'North observations',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',timeField:'day',csvText:'lon,lat,uuid,value,day\n-1,54,A,1,2025-01-01\n-2,53,B,2,2025-01-02'}},{id:'b',name:'Survey results',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',csvText:'lon,lat,uuid,value\n0,55,A,5\n0,55,B,6'}}]})),defaultConfig);
 await page.goto('/?time=all#analysis'); await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.every((s:any)=>s.done&&!s.filtering));
 await expect(page.locator('#workspaceNavigation > .page-menu > button')).toHaveText(['Analysis','Data sources']);
 await expect(page.locator('#recordsLink')).toBeHidden(); await page.locator('#analysisMenu').hover();
 await expect(page.locator('#analysisMenuPages a')).toHaveText(['Dashboard','Records']);
 await page.locator('#recordsLink').click(); await expect(page.locator('#records')).toBeVisible();
 await expect(page.locator('#recordsFilters')).not.toHaveAttribute('open',''); await expect(page.locator('#records .query-panel')).toBeHidden();
 await expect(page.locator('#records #derivedDatasets')).toHaveCount(0);
 await page.locator('#recordsFilters > summary').click();
 await page.locator('#rules > .filter-group > .group-head').getByRole('button',{name:'+ Rule',exact:true}).click();
 const rule=page.locator('#rules .rule'); await rule.getByLabel('Attribute',{exact:true}).selectOption('value'); await rule.getByLabel('Operator',{exact:true}).selectOption('gte'); await rule.getByLabel('Filter value',{exact:true}).fill('2'); await page.locator('#apply').click();
 await expect(page.locator('#records > [role=status]')).toContainText('1 table rows');
 await page.locator('#dataSourcesMenu').hover(); await expect(page.locator('#dataSourcesMenuPages a')).toHaveText(['Configuration','Derived datasets']);
 await page.locator('#derivedLink').click(); await expect(page.locator('#derived')).toBeVisible();
 await expect(page.locator('#derivedFilters')).not.toHaveAttribute('open',''); await expect(page.locator('#derived .filter-panel')).toBeHidden();
 await expect(page.locator('#derivedDatasets')).toBeVisible(); await page.locator('#derivedFilters > summary').click();
 await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2'); await expect(page.locator('#filterStatus')).toContainText('1 matches');
 await page.getByLabel('Left match field',{exact:true}).selectOption('uuid'); await page.getByLabel('Right match field',{exact:true}).selectOption('uuid');
 await page.getByLabel('Input rows',{exact:true}).selectOption('applied'); await page.getByRole('button',{name:'Preview join',exact:true}).click();
 await expect(page.locator('#joinStatus')).toContainText('1 output rows'); await expect(page.locator('.join-sample')).toContainText('North observations.value'); await expect(page.locator('.join-sample')).toContainText('Survey results.value');
 await navigate(page,'analysis'); await expect(page.locator('#analysis')).toBeVisible(); await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2');
 await expect(page.locator('#queryTitle')).toBeVisible(); await expect(page.locator('#rules')).toHaveCount(1); await expect(page.locator('.timeline')).toHaveCount(1);
 await navigate(page,'records'); await expect(page.locator('#recordsFilters')).toHaveAttribute('open',''); await expect(rule.getByLabel('Filter value',{exact:true})).toHaveValue('2');
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
 await page.goto('/#derived'); await expect(page.locator('#derivedDatasets')).toBeVisible(); await expect(page.locator('#derivedFilters')).not.toHaveAttribute('open','');
 await navigate(page,'records'); await expect(page.locator('#records')).toBeVisible(); await page.goBack(); await expect(page.locator('#derived')).toBeVisible();
 await page.reload(); await expect(page.locator('#derivedDatasets')).toBeVisible(); await expect(page.locator('#derivedFilters')).not.toHaveAttribute('open','');
});
