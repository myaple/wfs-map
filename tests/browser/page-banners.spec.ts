import { navigate } from '../navigation.ts';
import { test, expect } from '@playwright/test';
import { emptyState } from '../../src/analysis-state.ts';

test('shared header and footer survive every base view, errors, scrolling and narrow screens', async ({ page }) => {
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const doc = { id: 'example', name: 'Example', state: emptyState(), revision: 1, updatedAt: new Date().toISOString(), readOnly: path.includes('/shared/'), shared: true };
        let body: unknown;
        if (path === '/api/site-config') body = { bannerText: 'Internal <review>\nUse only', bannerBackground: '#ffdf80' };
        else if (path === '/api/me') body = { user: 'analyst' };
        else if (path === '/api/analyses') body = [];
        else if (path.includes('/missing')) return route.fulfill({ status: 404, body: 'Analysis not found' });
        else body = doc;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const check = async () => {
        for (const id of ['page-header', 'page-footer']) {
            const banner = page.locator('#' + id);
            await expect(banner).toBeVisible();
            await expect(banner).toHaveText('Internal <review> Use only');
            await expect(banner).toHaveCSS('background-color', 'rgb(255, 223, 128)');
            await expect(banner).toHaveCSS('white-space', 'nowrap');
            await expect(banner.locator('*')).toHaveCount(0);
            const box = await banner.boundingBox();
            expect(box!.height).toBe(32);
            expect(box!.y).toBe(id === 'page-header' ? 0 : page.viewportSize()!.height - 32);
        }
    };
    for (const url of ['/', '/?local=1#analysis', '/?analysis=example#configuration', '/?share=example#analysis', '/?analysis=missing']) {
        await page.goto(url);
        await expect(page.locator('#app')).not.toBeEmpty();
        await check();
        if (url.includes('#configuration')) {
            await expect(page.locator('#configuration')).toBeVisible();
            await navigate(page, 'analysis');
            await check();
        }
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await check();
    }
    await page.setViewportSize({ width: 360, height: 640 });
    await check();
});

test('empty deployment text leaves the page layout unchanged', async ({ page }) => {
    await page.route('**/api/site-config', route => route.fulfill({ json: { bannerText: '', bannerBackground: 'red' } }));
    await page.goto('/?local=1');
    await expect(page.locator('#page-header')).toBeHidden();
    await expect(page.locator('#page-footer')).toBeHidden();
    await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
});
