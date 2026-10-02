import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { start } from '../server/server.ts';
const server = start(0); await once(server, 'listening');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/#configuration`);
    for (const [name, url, layer] of [['Weather stations', 'https://data.example.org/geoserver/wfs', 'observations:stations'], ['Traffic sensors', 'https://transport.example.org/wfs', 'transport:sensors']]) {
        await page.locator('#addSource').click();
        await page.locator('#sourceName').fill(name); await page.locator('#url').fill(url); await page.locator('#layer').fill(layer);
        await page.locator('#updateSource').click();
    }
    await page.locator('#testServer summary').click();
    await page.screenshot({ path: 'benchmarks/data-sources.png', fullPage: true });
    await page.getByRole('button', { name: 'Configure Weather stations', exact: true }).click();
    await page.screenshot({ path: 'benchmarks/data-source-editor.png', fullPage: true });
    await page.locator('#cancelSource').click(); await page.setViewportSize({ width: 375, height: 900 });
    await page.screenshot({ path: 'benchmarks/data-sources-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Configure Weather stations', exact: true }).click();
    await page.screenshot({ path: 'benchmarks/data-source-editor-mobile.png', fullPage: true });
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
