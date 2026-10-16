import { navigate } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';

const overlayGeoJSON = JSON.stringify({
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', properties: { name: 'Harrogate' }, geometry: { type: 'Point', coordinates: [-1.54, 53.99] } },
        { type: 'Feature', properties: { name: 'Knaresborough' }, geometry: { type: 'Point', coordinates: [-1.47, 54.01] } },
        { type: 'Feature', properties: { name: 'Study boundary' }, geometry: { type: 'Polygon', coordinates: [[[-1.7, 53.9], [-1.3, 53.9], [-1.3, 54.1], [-1.7, 54.1], [-1.7, 53.9]]] } },
        { type: 'Feature', properties: { name: 'River' }, geometry: { type: 'LineString', coordinates: [[-1.6, 53.92], [-1.5, 54.0], [-1.4, 54.08]] } }
    ]
});
const overlayFile = { name: 'study-area.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(overlayGeoJSON) };

async function addOverlay(page: Page, name = 'Study area', color = 'Orange') {
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await page.locator('#overlayName').fill(name);
    await page.locator('#overlayFile').setInputFiles(overlayFile);
    await expect(page.locator('#overlayFileStatus')).toContainText('study-area.geojson');
    await page.locator('#overlayColor').selectOption({ label: color });
    await page.locator('#addOverlaySource').click();
    // Dialog stays open so the new overlay appears in the active list inside it.
    await expect(page.locator('#overlayDialog')).toBeVisible();
    await expect(page.locator('#overlayList .overlay-row').filter({ hasText: name })).toHaveCount(1);
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('wfs-settings')!));
const idbKeys = (page: Page) => page.evaluate(async () => {
    const { indexedDB } = window;
    return await new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('wfs-source-files', 1);
        open.onsuccess = () => {
            const db = open.result, tx = db.transaction('csv'), request = tx.objectStore('csv').getAllKeys();
            tx.oncomplete = () => { resolve(request.result as string[]); db.close(); };
            tx.onabort = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
    });
});
const overlayLayers = (page: Page) => page.evaluate(() => {
    const map = (window as any).__WFS_MAP__.map;
    return ['fill', 'line', 'point'].map(kind => {
        const layer = map.getStyle().layers.find((l: any) => l.id.endsWith('-' + kind) && l.id.startsWith('overlay-'));
        return layer ? { id: layer.id, visible: layer.layout?.visibility !== 'none', radius: layer.paint?.['circle-radius'], color: layer.paint?.['circle-color'] ?? layer.paint?.['line-color'] ?? layer.paint?.['fill-color'] } : null;
    });
});

test('GeoJSON overlay plots on the map, follows the point size slider, and saves like CSV', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all&points=512&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    // The overlay button sits in the map toolbar next to the show ellipses button.
    await expect(page.locator('#toggleEllipses')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true })).toBeVisible();
    await addOverlay(page);
    // The active overlay list is inside the dialog, not a side panel.
    // Close the dialog to see the map without any side panel.
    await page.locator('#closeOverlay').click();
    await expect(page.locator('#overlayDialog')).not.toBeVisible();
    // No side panel: the overlay list only exists inside the dialog.
    await expect(page.locator('#overlayList')).toBeHidden();
    // Reopen the dialog: the overlay is listed there with its colour swatch.
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await expect(page.locator('#overlayList .overlay-row')).toContainText('Study area');
    await expect(page.locator('#overlayList .overlay-row')).toContainText('study-area.geojson');
    await page.locator('#closeOverlay').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-')));
    const layers = await overlayLayers(page);
    expect(layers.map(l => l?.visible)).toEqual([true, true, true]);
    expect(layers[2]?.color).toBe('#d45b24');
    // Point features respect the point size slider.
    const pointLayerId = async () => await page.evaluate(() => (window as any).__WFS_MAP__.map.getStyle().layers.find((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')).id);
    const pointRadius = async () => await page.evaluate(id => (window as any).__WFS_MAP__.map.getPaintProperty(id, 'circle-radius'), await pointLayerId());
    expect(await pointRadius()).toEqual(['max', 1, ['/', 2, 2]]);
    await page.locator('#size').fill('6');
    await expect.poll(pointRadius).toEqual(['max', 1, ['/', 6, 2]]);
    // Overlays are not dataset sources: no worker, no charts, not in filter/export selects.
    expect(await page.evaluate(() => (window as any).__WFS_MAP__.sources.some((s: any) => s.config.type === 'overlay'))).toBe(false);
    expect(await page.locator('#filterSource option')).toHaveCount(1); // only the WFS source
    expect(await page.locator('#exportSource option')).toHaveCount(1);
    // Save analysis persists the overlay like a CSV source: metadata in
    // localStorage, file contents in IndexedDB.
    await navigate(page, 'configuration');
    await expect(page.locator('#sourceList .source-row').filter({ hasText: 'Study area' })).toHaveCount(1);
    await expect(page.locator('#sourceList .source-row').filter({ hasText: 'Study area' })).toContainText('GeoJSON overlay');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    const settings = await saved(page);
    const overlay = settings.sources.find((s: any) => s.config.type === 'overlay');
    expect(overlay.name).toBe('Study area');
    expect(overlay.config.overlayGeoJSON).toBe('');
    expect(overlay.config.overlayFileName).toBe('study-area.geojson');
    expect(overlay.config.overlayColor).toBe('#d45b24');
    expect(overlay.config.csvRef).toBeTruthy();
    expect(await page.evaluate(() => localStorage.getItem('wfs-settings')!.length)).toBeLessThan(10_000);
    expect(await idbKeys(page)).toEqual([overlay.config.csvRef]);
    await page.screenshot({ path: 'test-results/overlay-saved.png', fullPage: false });
    // Reload: the overlay is restored from IndexedDB and drawn again.
    await page.reload();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')));
    // Navigate back to the analysis page (reload may land on configuration).
    await navigate(page, 'analysis');
    // Overlay restored: open the dialog to see it in the active list.
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await expect(page.locator('#overlayList .overlay-row')).toContainText('Study area');
    const restored = await overlayLayers(page);
    expect(restored.map(l => l?.visible)).toEqual([true, true, true]);
    expect(restored[2]?.color).toBe('#d45b24');
    // The overlay survives with the loaded dataset visible.
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    await expect(page.locator('#hud')).toContainText('Loaded');
    // Toggling visibility hides the layers without removing the source.
    await page.getByLabel('Show Study area', { exact: true }).uncheck();
    await expect.poll(async () => (await overlayLayers(page)).map(l => l?.visible)).toEqual([false, false, false]);
    await page.getByLabel('Show Study area', { exact: true }).check();
    await expect.poll(async () => (await overlayLayers(page)).map(l => l?.visible)).toEqual([true, true, true]);
    await page.screenshot({ path: 'test-results/overlay-restored.png', fullPage: false });
    // Removing the overlay removes its layers and its saved source.
    // (The dialog is still open from the visibility toggle section above.)
    await page.getByRole('button', { name: 'Remove Study area', exact: true }).click();
    await expect(page.locator('#overlayList .overlay-row')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-')))).toBe(false);
    // Close the dialog and navigate to configuration.
    await page.locator('#closeOverlay').click();
    await expect(page.locator('#overlayDialog')).not.toBeVisible();
    await navigate(page, 'configuration');
    await expect(page.locator('#sourceList .source-row')).toHaveCount(1); // only the WFS source remains
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    expect((await saved(page)).sources.some((s: any) => s.config.type === 'overlay')).toBe(false);
    await expect.poll(() => idbKeys(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('Multiple overlays with the same file save correctly, and overlay config dialog has a single name field', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all&points=512&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    // Add first overlay via toolbar and save.
    await addOverlay(page, 'Overlay A');
    await page.locator('#closeOverlay').click();
    await navigate(page, 'configuration');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    // Add a second overlay with the SAME file (different name) and save again.
    // Before the fix, the first overlay's config lost its inline GeoJSON after
    // save+apply, so validateConfig threw "Choose a GeoJSON file." on save 2.
    await navigate(page, 'analysis');
    await addOverlay(page, 'Overlay B');
    await page.locator('#closeOverlay').click();
    await navigate(page, 'configuration');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    await expect(page.locator('#saveError')).toBeHidden();
    const settings = await saved(page);
    const overlayNames = settings.sources.filter((s: any) => s.config.type === 'overlay').map((s: any) => s.name);
    expect(overlayNames).toEqual(['Overlay A', 'Overlay B']);
    // Both overlays have distinct csvRefs and both files exist in IndexedDB.
    const refs = settings.sources.filter((s: any) => s.config.type === 'overlay').map((s: any) => s.config.csvRef);
    expect(refs[0]).not.toBe(refs[1]);
    expect(await idbKeys(page)).toEqual(expect.arrayContaining(refs));
    // The configure dialog has a single source name field (no duplicate overlay name).
    await page.getByRole('button', { name: 'Configure Overlay A', exact: true }).click();
    await expect(page.locator('#sourceName')).toHaveValue('Overlay A');
    await expect(page.locator('#overlaySourceName')).toHaveCount(0); // removed
    await expect(page.locator('#overlaySourceFileStatus')).toContainText('study-area.geojson');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // An overlay can also be created from the "Add data source" dialog.
    await page.locator('#addSource').click();
    await page.locator('#type').selectOption('overlay');
    await page.locator('#sourceName').fill('Config Created');
    await page.locator('#overlaySourceFile').setInputFiles(overlayFile);
    await expect(page.locator('#overlaySourceFileStatus')).toContainText('study-area.geojson');
    await page.locator('#updateSource').click();
    await expect(page.locator('#sourceDialog')).not.toBeVisible();
    await expect(page.locator('#sourceList .source-row').filter({ hasText: 'Config Created' })).toHaveCount(1);
    // Save with three overlays (two sharing the same file content).
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    await expect(page.locator('#saveError')).toBeHidden();
    const finalSettings = await saved(page);
    expect(finalSettings.sources.filter((s: any) => s.config.type === 'overlay')).toHaveLength(3);
    const finalRefs = finalSettings.sources.filter((s: any) => s.config.type === 'overlay').map((s: any) => s.config.csvRef);
    expect(new Set(finalRefs).size).toBe(3); // all distinct
    expect(await idbKeys(page)).toEqual(expect.arrayContaining(finalRefs));
    expect(errors).toEqual([]);
});

test('GeoJSON overlay visibility toggle persists across reload', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all&points=512&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    // Add and save an overlay.
    await addOverlay(page, 'Toggle Test');
    await page.locator('#closeOverlay').click();
    await navigate(page, 'configuration');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    // Go back to analysis, open the dialog, uncheck visibility.
    await navigate(page, 'analysis');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await page.getByLabel('Show Toggle Test', { exact: true }).uncheck();
    await expect.poll(async () => (await overlayLayers(page)).map(l => l?.visible)).toEqual([false, false, false]);
    // Reload: visibility must stay off (was previously reset to on).
    await page.locator('#closeOverlay').click();
    await page.reload();
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await navigate(page, 'analysis');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')));
    // All three layers must be hidden.
    await expect.poll(async () => (await overlayLayers(page)).map(l => l?.visible)).toEqual([false, false, false]);
    // Checkbox reflects the persisted state.
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await expect(page.getByLabel('Show Toggle Test', { exact: true })).not.toBeChecked();
    await page.locator('#closeOverlay').click();
    // Verify the source's enabled flag was saved as false.
    const settings = await saved(page);
    const overlay = settings.sources.find((s: any) => s.config.type === 'overlay');
    expect(overlay.enabled).toBe(false);
    expect(errors).toEqual([]);
});

test('GeoJSON overlay picks up saved configuration changes (name, colour, GeoJSON)', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?time=all&points=512&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    // Add and save an orange overlay named "Original".
    await addOverlay(page, 'Original', 'Orange');
    await page.locator('#closeOverlay').click();
    await navigate(page, 'configuration');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    // Verify initial state: orange layers.
    await navigate(page, 'analysis');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')));
    let layers = await overlayLayers(page);
    expect(layers[2]?.color).toBe('#d45b24'); // orange point
    // Go to config, rename to "Renamed", change colour to Teal.
    await navigate(page, 'configuration');
    await page.getByRole('button', { name: 'Configure Original', exact: true }).click();
    await page.locator('#sourceName').fill('Renamed');
    await page.locator('#overlaySourceColor').selectOption({ label: 'Teal' });
    await page.locator('#updateSource').click();
    await expect(page.locator('#sourceDialog')).not.toBeVisible();
    await page.locator('#saveSettings').click();
    await expect(page.locator('#saveState')).toContainText('Saved in this browser');
    // Back to analysis: the overlay dialog must show the new name.
    await navigate(page, 'analysis');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.done);
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await expect(page.locator('#overlayList .overlay-row')).toContainText('Renamed');
    // Layers must be teal now (not stale orange).
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')));
    layers = await overlayLayers(page);
    expect(layers[2]?.color).toBe('#17836f'); // teal point
    expect(layers[1]?.color).toBe('#17836f'); // teal line
    expect(layers[0]?.color).toBe('#17836f'); // teal fill
    await page.locator('#closeOverlay').click();
    expect(errors).toEqual([]);
});

test('GeoJSON overlay dialog validates files and lists colours', async ({ page }) => {
    await page.goto('/?time=all');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.map.loaded());
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    // Colour list is populated.
    expect(await page.locator('#overlayColor option').count()).toBeGreaterThanOrEqual(8);
    // Name and file are required (the form blocks empty submits, so exercise
    // the handler's own validation by clearing the required attribute).
    await page.locator('#overlayName').evaluate(el => el.removeAttribute('required'));
    await page.locator('#overlayFile').setInputFiles([]);
    await page.locator('#addOverlaySource').click();
    await expect(page.locator('#overlayError')).toContainText('Enter an overlay name');
    await page.locator('#overlayName').fill('Broken');
    await page.locator('#addOverlaySource').click();
    await expect(page.locator('#overlayError')).toContainText('Choose a GeoJSON file');
    // Invalid JSON is rejected at file-read time (the onchange handler sets
    // the error immediately) and again at submit time.
    await page.locator('#overlayFile').setInputFiles({ name: 'bad.geojson', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
    await expect(page.locator('#overlayError')).toContainText('not valid GeoJSON');
    await page.locator('#addOverlaySource').click();
    await expect(page.locator('#overlayDialog')).toBeVisible(); // still open, not added
    // A bare geometry is accepted.
    await page.locator('#overlayName').fill('Single point');
    await page.locator('#overlayFile').setInputFiles({ name: 'point.geojson', mimeType: 'application/json', buffer: Buffer.from('{"type":"Point","coordinates":[-1.5,54]}') });
    await expect(page.locator('#overlayFileStatus')).toContainText('1 point features');
    await page.locator('#addOverlaySource').click();
    // Dialog stays open: the new overlay appears in the active list inside it.
    await expect(page.locator('#overlayDialog')).toBeVisible();
    await expect(page.locator('#overlayList .overlay-row')).toContainText('Single point');
    await page.waitForFunction(() => (window as any).__WFS_MAP__.map.getStyle().layers.some((l: any) => l.id.startsWith('overlay-') && l.id.endsWith('-point')));
    // Close the dialog: the overlay list is hidden (no side panel).
    await page.locator('#closeOverlay').click();
    await expect(page.locator('#overlayDialog')).not.toBeVisible();
    await expect(page.locator('#overlayList')).toBeHidden();
    // Reopen: the overlay is still listed.
    await page.getByRole('button', { name: 'Add GeoJSON overlay', exact: true }).click();
    await expect(page.locator('#overlayList .overlay-row')).toHaveCount(1);
    // Cancel closes the dialog without adding anything.
    await page.locator('#cancelOverlay').click();
    await expect(page.locator('#overlayDialog')).not.toBeVisible();
    // The overlay can be reconfigured from Data sources like any source.
    await navigate(page, 'configuration');
    await page.getByRole('button', { name: 'Configure Single point', exact: true }).click();
    await expect(page.locator('#type')).toHaveValue('overlay');
    await expect(page.locator('#overlaySourceFileStatus')).toContainText('point.geojson');
    await page.locator('#overlaySourceColor').selectOption({ label: 'Teal' });
    await page.locator('#overlaySourceFile').setInputFiles(overlayFile);
    await expect(page.locator('#overlaySourceFileStatus')).toContainText('2 point features');
    await page.locator('#updateSource').click();
    await expect(page.locator('#sourceList .source-row')).toContainText('GeoJSON overlay · study-area.geojson');
});
