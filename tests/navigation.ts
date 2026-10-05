import type { Page } from '@playwright/test';
export async function navigate(page: Page, target: 'analysis' | 'records' | 'configuration' | 'derived') {
 const group = target === 'analysis' || target === 'records' ? '#analysisMenu' : '#dataSourcesMenu';
 const link = {analysis:'#analysisLink', records:'#recordsLink', configuration:'#configLink', derived:'#derivedLink'}[target];
 await page.locator(group).click();
 await page.locator(link).click();
}
