import { test, expect, type Page } from '@playwright/test';
async function add(page: Page, name = 'Stations', url = '/wfs?points=128&vendor=keep') {
    await page.locator('#addSource').click();
    await page.getByLabel('Source name', { exact: true }).fill(name);
    await page.getByLabel('WFS endpoint', { exact: true }).fill(url);
    await page.getByLabel('Custom layer name', { exact: true }).fill('demo:points');
    await page.getByRole('button', { name: 'Add to list', exact: true }).click();
}
const sourceStorage = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings') ?? 'null'));
test('clean first visit has a generic empty list; drafts, cancel and discard never autosave', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all#configuration');
    await expect(page.locator('#sourceList')).toContainText('No data sources yet');
    await expect(page.locator('#load')).toBeDisabled();
    await expect(page.locator('#url')).toBeHidden();
    await expect(page.locator('#testServer')).not.toHaveAttribute('open');
    await page.locator('#addSource').click();
    await expect(page.locator('#url')).toHaveValue('');
    await expect(page.locator('#layer')).toHaveValue('');
    await expect(page.locator('#sourceDialog #points')).toHaveCount(0);
    await page.locator('#sourceName').fill('Cancelled');
    await page.keyboard.press('Escape');
    await expect(page.locator('.source-row')).toHaveCount(0);
    await add(page);
    await expect(page.locator('.source-row')).toHaveCount(1);
    await expect(page.locator('#saveState')).toHaveText('Unsaved changes');
    expect(await sourceStorage(page)).toBeNull();
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.length)).toBe(0);
    await page.locator('#analysisLink').click(); await expect(page.locator('#load')).toBeDisabled();
    await page.locator('#configLink').click(); await page.locator('#discardSettings').click();
    await expect(page.locator('.source-row')).toHaveCount(0);
    await expect(page.locator('#saveSettings')).toBeDisabled();
    expect(errors).toEqual([]);
});
test('save applies sources and background atomically; configuration pops out and survives reload', async ({ page }) => {
    const requests: string[] = []; page.on('request', r => { if (r.url().includes('/wfs?')) requests.push(r.url()); });
    await page.goto('/?time=all#configuration'); await add(page);
    await page.locator('#backgroundSettings summary').click();
    await page.locator('#basemapURL').fill(''); await page.locator('#basemapAttribution').fill('Offline');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toHaveText('Saved in this browser');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    const saved = await sourceStorage(page);
    expect(saved.sources[0].config.url).toBe('/wfs?points=128&vendor=keep');
    expect(saved.sources[0].config).not.toHaveProperty('points');
    expect(saved.background.url).toBe('');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(url => new URL(url).searchParams.get('vendor') === 'keep' && new URL(url).searchParams.get('points') === '128')).toBe(true);
    await page.getByRole('button', { name: 'Configure Stations', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.locator('#sourceName').fill('New name'); await page.locator('#cancelSource').click();
    await expect(page.locator('.source-row')).toContainText('Stations');
    await page.getByRole('button', { name: 'Configure Stations', exact: true }).click();
    await page.locator('#sourceName').fill('Weather stations'); await page.locator('#updateSource').click();
    expect((await sourceStorage(page)).sources[0].name).toBe('Stations');
    await page.locator('#saveSettings').click(); await page.reload();
    await expect(page.locator('.source-row')).toContainText('Weather stations');
    await expect(page.getByRole('checkbox', { name: 'Enable Weather stations', exact: true })).toBeChecked();
    await page.locator('#backgroundSettings summary').click(); await expect(page.locator('#basemapURL')).toHaveValue('');
});
test('removal can be undone and saved removal of the last loaded source releases data and remains empty', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all#configuration'); await add(page); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    await page.evaluate(() => (window as any).__removedSource = (window as any).__WFS_MAP__.sources[0]);
    await page.getByRole('button', { name: 'Remove Stations', exact: true }).click();
    expect((await sourceStorage(page)).sources).toHaveLength(1);
    await page.locator('#undoRemove').click(); await expect(page.locator('.source-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove Stations', exact: true }).click(); await page.locator('#saveSettings').click();
    expect((await sourceStorage(page)).sources).toHaveLength(0);
    const cleared = await page.evaluate(() => { const s = (window as any).__removedSource; return { loaded: s.loaded, bytes: s.layer.gpuBytes, worker: !!s.worker }; });
    expect(cleared).toEqual({ loaded: 0, bytes: 0, worker: false });
    await page.locator('#analysisLink').click(); await expect(page.locator('#hud')).toContainText('Loaded 0');
    await expect(page.locator('#filterSource')).toBeDisabled(); await page.reload();
    await page.locator('#configLink').click(); await expect(page.locator('.source-row')).toHaveCount(0);
    await add(page, 'Replacement'); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    expect(errors).toEqual([]);
});
test('start a test WFS separately and add it through the normal editor', async ({ page }) => {
    await page.goto('/?time=all#configuration'); await page.locator('#testServer summary').click();
    await page.locator('#points').fill('96'); await page.locator('#distribution').selectOption('dense');
    await page.locator('#startTestServer').click(); await expect(page.locator('#testServerStatus')).toContainText('is running');
    await expect(page.locator('.source-row')).toHaveCount(0); expect(await sourceStorage(page)).toBeNull();
    await page.locator('#addTestSource').click(); await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#url')).toHaveValue('/test-wfs?points=96&distribution=dense');
    await expect(page.locator('#sourceDialog #distribution')).toHaveCount(0);
    await page.locator('#sourceName').fill('Local sample'); await page.locator('#discover').click();
    await expect(page.locator('#discoveryStatus')).toContainText('1 layer(s)');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[0]?.done);
    expect((await sourceStorage(page)).sources[0].config).not.toHaveProperty('distribution');
    await page.locator('#analysisLink').click(); await expect(page.locator('#hud')).toContainText('Loaded 96');
    await page.reload(); await page.locator('#load').click(); await page.waitForFunction(() => (window as any).__WFS_MAP__.done);
    await expect(page.locator('#hud')).toContainText('Loaded 96');
});
test('validation and storage failure leave drafts available without changing running sources', async ({ page }) => {
    await page.goto('/?time=all#configuration'); await add(page);
    await page.locator('#backgroundSettings summary').click(); await page.locator('#basemapURL').fill('javascript:bad');
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveError')).toContainText('XYZ tile URL');
    expect(await sourceStorage(page)).toBeNull();
    await page.locator('#basemapURL').fill('');
    await page.evaluate(() => { (window as any).__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
    await page.locator('#saveSettings').click(); await expect(page.locator('#saveError')).toContainText('Storage full');
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.length)).toBe(0);
    await expect(page.locator('#saveState')).toHaveText('Unsaved changes');
    await page.evaluate(() => Storage.prototype.setItem = (window as any).__setItem);
    await page.locator('#saveSettings').click(); expect((await sourceStorage(page)).sources).toHaveLength(1);
});
test('legacy source settings migrate without changing remote endpoints or losing generated fixture parameters', async ({ page }) => {
    await page.addInitScript(() => {
        if (localStorage.getItem('wfs-settings')) return;
        const config = { url: '/wfs', layer: 'demo:points', points: '17', distribution: 'world', version: '2.0.0', format: 'application/json', srs: 'urn:ogc:def:crs:OGC:1.3:CRS84', axis: 'xy', sort: '', pageSize: '50000', limit: '10000000' };
        localStorage.setItem('wfs-sources', JSON.stringify([{ id: 'old', name: 'Existing test source', enabled: true, config }, { id: 'remote', name: 'Remote', enabled: false, config: { ...config, url: 'https://data.example/wfs?token=abc&vendor=yes' } }]));
    });
    await page.goto('/?time=all#configuration');
    await page.getByRole('button', { name: 'Configure Existing test source', exact: true }).click();
    await expect(page.locator('#url')).toHaveValue('/wfs?points=17&distribution=world'); await page.locator('#cancelSource').click();
    await page.getByRole('button', { name: 'Configure Remote', exact: true }).click();
    await expect(page.locator('#url')).toHaveValue('https://data.example/wfs?token=abc&vendor=yes');
    await page.locator('#sourceName').fill('Remote renamed'); await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    const saved = await sourceStorage(page); expect(saved.sources[0].config).not.toHaveProperty('points');
    expect(saved.sources[1].config.url).toBe('https://data.example/wfs?token=abc&vendor=yes');
});
test('source limit, keyboard editor focus and narrow layouts remain usable', async ({ page }) => {
    await page.goto('/?time=all#configuration');
    for (let i = 0; i < 8; i++) await add(page, `Source ${i}`, `/wfs?points=${i + 1}`);
    await expect(page.locator('#addSource')).toBeDisabled();
    await page.getByRole('button', { name: 'Remove Source 7', exact: true }).click(); await expect(page.locator('#addSource')).toBeEnabled();
    await page.locator('#undoRemove').click(); await expect(page.locator('#addSource')).toBeDisabled();
    for (const width of [1440, 820, 375]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const opener = page.getByRole('button', { name: 'Configure Source 0', exact: true });
        await opener.focus(); await page.keyboard.press('Enter');
        await expect(page.locator('#sourceName')).toBeFocused();
        await page.locator('#wfsCompatibility summary').click();
        expect(await page.locator('#sourceDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
        await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
    }
    await page.locator('#discardSettings').click();
});
test('failed discovery allows manual configuration; unavailable test hosting reports an actionable error', async ({ page }) => {
    await page.route('**/api/test-wfs/start', route => route.fulfill({ status: 404 }));
    await page.route('**/external-wfs?*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.goto('/?time=all#configuration'); await page.locator('#testServer summary').click(); await page.locator('#startTestServer').click();
    await expect(page.locator('#testServerStatus')).toContainText('Could not start'); await expect(page.locator('#addTestSource')).toBeDisabled();
    await page.locator('#addSource').click(); await page.locator('#sourceName').fill('Manual'); await page.locator('#url').fill('/external-wfs');
    await page.locator('#discover').click(); await expect(page.locator('#discoveryStatus')).toContainText('Discovery failed');
    await page.locator('#layer').fill('vendor:manual'); await page.locator('#updateSource').click();
    await expect(page.locator('.source-row')).toContainText('vendor:manual'); await page.locator('#discardSettings').click();
});

test('closing or changing endpoints aborts discovery and cannot populate another editor', async ({ page }) => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => release = resolve);
    await page.route('**/slow-wfs?*', async route => {
        await blocked;
        await route.fulfill({ contentType: 'application/xml', body: '<WFS_Capabilities><FeatureType><Name>stale:layer</Name></FeatureType></WFS_Capabilities>' }).catch(() => {});
    });
    await page.goto('/?time=all#configuration'); await page.locator('#addSource').click();
    await page.locator('#url').fill('/slow-wfs');
    const requested = page.waitForRequest(r => r.url().includes('/slow-wfs?'));
    await page.locator('#discover').click(); await requested;
    await page.keyboard.press('Escape'); await page.locator('#addSource').click();
    await expect(page.locator('#discover')).toBeEnabled();
    release();
    await page.locator('#sourceName').fill('Fresh source');
    await expect(page.locator('#layer')).toHaveValue(''); await expect(page.locator('#discoveryStatus')).toBeEmpty();
    await page.locator('#url').fill('/wfs?points=16'); await page.locator('#discover').click();
    await expect(page.locator('#discoveryStatus')).toContainText('1 layer(s)'); await expect(page.locator('#layer')).toHaveValue('demo:points');
    await page.locator('#cancelSource').click();
});

test('discovery offers all layers in a dropdown; selected and custom names survive Save and Configure', async ({ page }) => {
    const capabilities = `<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0">
      <wfs:FeatureTypeList>
        <wfs:FeatureType><wfs:Name> demo:points </wfs:Name><wfs:Title>Observation stations</wfs:Title><wfs:OutputFormats><wfs:Format>application/json</wfs:Format></wfs:OutputFormats></wfs:FeatureType>
        <wfs:FeatureType><wfs:Name>demo:other</wfs:Name><wfs:Title>Other observations</wfs:Title><wfs:OutputFormats><wfs:Format>application/geo+json</wfs:Format></wfs:OutputFormats></wfs:FeatureType>
        <wfs:FeatureType><wfs:Name>demo:third</wfs:Name></wfs:FeatureType>
      </wfs:FeatureTypeList></wfs:WFS_Capabilities>`;
    await page.route('**/wfs?*', async route => {
        if (new URL(route.request().url()).searchParams.get('request') === 'GetCapabilities')
            await route.fulfill({ contentType: 'application/xml', body: capabilities });
        else await route.continue();
    });
    await page.goto('/?time=all#configuration');
    await page.locator('#addSource').click();
    await page.getByLabel('Source name', { exact: true }).fill('Layers');
    await page.getByLabel('WFS endpoint', { exact: true }).fill('/wfs?points=16');
    await page.locator('#discover').click();
    await expect(page.locator('#discoveryStatus')).toContainText('3 layer(s) found');
    const layers = page.getByLabel('Feature layer', { exact: true });
    await expect(layers.locator('option')).toHaveText([
        'Observation stations (demo:points)', 'Other observations (demo:other)', 'demo:third', 'Custom layer name…'
    ]);
    await expect(layers).toHaveValue('demo:points');
    await expect(page.getByLabel('Custom layer name', { exact: true })).toBeHidden();
    await layers.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(layers).toHaveValue('demo:other');
    await page.locator('#wfsCompatibility summary').click();
    await expect(page.locator('#format')).toHaveValue('application/geo+json');
    await page.locator('#updateSource').click();
    await page.getByRole('checkbox', { name: 'Enable Layers', exact: true }).uncheck();
    await page.locator('#saveSettings').click();
    expect((await sourceStorage(page)).sources[0].config.layer).toBe('demo:other');
    await page.getByRole('button', { name: 'Configure Layers', exact: true }).click();
    await expect(layers).toHaveValue('demo:other');
    await page.locator('#discover').click();
    await expect(page.locator('#discoveryStatus')).toContainText('3 layer(s) found');
    await expect(layers).toHaveValue('demo:other');
    await layers.selectOption('');
    await expect(page.getByLabel('Custom layer name', { exact: true })).toBeFocused();
    await page.getByLabel('Custom layer name', { exact: true }).fill('vendor:manual');
    await page.locator('#discover').click();
    await expect(page.locator('#discoveryStatus')).toContainText('3 layer(s) found');
    await expect(layers).toHaveValue('');
    await expect(page.locator('#layer')).toHaveValue('vendor:manual');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    expect((await sourceStorage(page)).sources[0].config.layer).toBe('vendor:manual');
    await page.reload();
    await page.getByRole('button', { name: 'Configure Layers', exact: true }).click();
    await expect(layers).toHaveValue('vendor:manual');
    await layers.selectOption(''); await expect(page.locator('#layer')).toHaveValue('vendor:manual');
    await page.locator('#discover').click(); await expect(page.locator('#discoveryStatus')).toContainText('3 layer(s) found');
    await page.locator('#url').fill('/other-wfs');
    await expect(layers.locator('option')).toHaveCount(1);
    await expect(page.locator('#layer')).toBeVisible();
    await expect(page.locator('#discoveryStatus')).toBeEmpty();
});
