import type { Page } from '@playwright/test';
export async function navigate(page: Page, target: 'analysis' | 'records' | 'configuration' | 'derived') {
 const group = target === 'analysis' || target === 'records' ? '#analysisMenu' : '#dataSourcesMenu';
 const link = {analysis:'#analysisLink', records:'#recordsLink', configuration:'#configLink', derived:'#derivedLink'}[target];
 await page.locator(group).click();
 await page.locator(link).click();
}

export async function openFilters(page: Page) {
 const toggle = page.locator('#toggleFilters');
 if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
export async function openTimeline(page: Page) {
 const toggle = page.locator('#toggleTimeline');
 if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
