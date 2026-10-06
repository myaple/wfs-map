import { settingsKey, setSettingsScope, type Settings } from './source-settings.ts';
import { fileUser, setFileUser, readCSVBlob, stageCSVFile, saveSettings } from './source-storage.ts';
import { localSettings, type AnalysisDocument, type AnalysisState } from './analysis-state.ts';
import { api, createAnalysis, saveAnalysis } from './analyses-api.ts';
export let currentAnalysis: AnalysisDocument | undefined;
export async function prepareAnalysis(doc: AnalysisDocument, user: string) {
    currentAnalysis = doc;
    setFileUser(user);
    setSettingsScope(`wfs-analysis-settings:${encodeURIComponent(user)}:${doc.readOnly ? 'shared:' : ''}${doc.id}`);
    const settings = localSettings(doc.state);
    let bindings: Record<string, string> = {};
    try { bindings = JSON.parse(localStorage.getItem(settingsKey + ':bindings') ?? '{}'); } catch {}
    for (const s of settings.sources) if (s.config.type === 'csv' && bindings[s.config.csvRef]) s.config.csvRef = bindings[s.config.csvRef];
    localStorage.setItem(settingsKey, JSON.stringify(settings));
}
export function rememberBindings(settings: Settings) {
    if (!currentAnalysis) return;
    let bindings: Record<string, string> = {};
    try { bindings = JSON.parse(localStorage.getItem(settingsKey + ':bindings') ?? '{}'); } catch {}
    for (const source of currentAnalysis.state.settings.sources) {
        const next = settings.sources.find(s => s.id === source.id);
        if (source.config.type === 'csv' && source.config.csvRef && next?.config.csvRef) bindings[source.config.csvRef] = next.config.csvRef;
    }
    localStorage.setItem(settingsKey + ':bindings', JSON.stringify(bindings));
}
export const localAnalysisKey = () => settingsKey + ':analysis';
// Promote a standalone session when the workspace service is available. Copy
// immutable CSV blobs into the authenticated user's cache before publishing references.
async function createFromBrowser(name: string, state: AnalysisState) {
    const identity = await api<{ user: string }>('/me'), previousUser = fileUser;
    const files = await Promise.all(state.settings.sources.filter(s => s.config.type === 'csv').map(async s => ({ ref: s.config.csvRef, blob: await readCSVBlob(s.config.csvRef) })));
    try {
        setFileUser(identity.user);
        for (const file of files) stageCSVFile(file.ref, file.blob);
        await saveSettings(localSettings(state));
        const copy = await createAnalysis(name, state);
        location.href = '/?analysis=' + encodeURIComponent(copy.id) + location.hash;
    } finally { setFileUser(previousUser); }
}
export function mountAnalysisControls(snapshot: () => AnalysisState, host: HTMLElement, dock: HTMLElement, saveLocal: () => Promise<AnalysisState>) {
    const dockGroup = document.createElement('div'); dockGroup.className = 'dock-save';
    const dockStatus = document.createElement('span'); dockStatus.className = 'dock-save-status hint'; dockStatus.setAttribute('role', 'status');
    const dockButton = document.createElement('button'); dockButton.id = 'dockSaveAnalysis'; dockButton.className = 'primary'; dockButton.disabled = true;
    dockGroup.append(dockStatus, dockButton); dock.append(dockGroup);
    const doc = currentAnalysis;
    let baseline = '', busy = false, retry = false;
    const initialName = doc?.name ?? 'Untitled analysis';
    const fingerprint = (name = initialName) => JSON.stringify({ name, state: snapshot() });
    try { baseline = fingerprint(); } catch {}
    const bar = document.createElement('section'); bar.className = 'saved-analysis-bar';
    const back = document.createElement('a'); back.href = '/'; back.textContent = 'All analyses';
    const name = document.createElement('input'); name.value = initialName; name.maxLength = 120; name.setAttribute('aria-label', 'Analysis name'); name.readOnly = !!doc?.readOnly;
    if (doc) document.title = `${doc.name} · WFS analysis`;
    const status = document.createElement('span'); status.id = 'saveState'; status.setAttribute('role', 'status'); status.className = 'hint';
    status.textContent = doc?.readOnly ? 'Shared setup · save your changes as a new analysis.' : 'All analysis changes saved';
    const link = document.createElement('input'); link.readOnly = true; link.hidden = true; link.setAttribute('aria-label', 'Shared analysis link');
    const refresh = () => {
        let dirty = true;
        try { dirty = retry || fingerprint(name.value.trim()) !== baseline; } catch { /* Invalid drafts require correction. */ }
        dockButton.disabled = busy || !dirty;
        const configSave = bar.querySelector<HTMLButtonElement>('#saveSettings');
        if (configSave) configSave.disabled = busy || (!doc && !dirty);
        dockButton.title = dirty ? 'Save the current analysis configuration' : 'All analysis changes saved';
        if (!busy && !dirty) { dockStatus.textContent = 'Saved'; if (status.textContent === 'Unsaved changes') status.textContent = 'All analysis changes saved'; }
        else if (!busy && dockStatus.textContent === 'Saved') dockStatus.textContent = 'Unsaved changes';
        if (!busy && dirty && status.textContent === 'All analysis changes saved') status.textContent = 'Unsaved changes';
    };
    // Compare only portable metadata, never loaded rows or chart buffers.
    window.setInterval(refresh, 500);
    let refreshFrame = 0;
    for (const event of ['input', 'change', 'click', 'analysischange']) window.addEventListener(event, () => {
        if (!refreshFrame) refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
    });
    const buttons: HTMLButtonElement[] = [];
    const action = (label: string, run: () => Promise<void>) => {
        const button = document.createElement('button'); button.textContent = label; buttons.push(button);
        button.onclick = async () => {
            if (busy) return;
            busy = true; buttons.forEach(b => b.disabled = true); status.textContent = dockStatus.textContent = 'Saving configuration…'; dockButton.disabled = true;
            try { await run(); }
            catch (e) { retry = true; status.textContent = dockStatus.textContent = (e as Error).message; }
            finally { busy = false; buttons.forEach(b => b.disabled = false); refresh(); }
        };
        return button;
    };
    const save = async () => {
        const savedName = name.value.trim();
        if (!savedName) throw Error('Enter an analysis name.');
        const state = await saveLocal();
        try {
            if (!doc) { await createFromBrowser(savedName, state); return; }
            rememberBindings(state.settings);
            currentAnalysis = await saveAnalysis(currentAnalysis!, savedName, state);
        } catch (e) {
            throw Error(`Saved in this browser · Remote save failed: ${(e as Error).message}`);
        }
        // The baseline is the exact saved snapshot. In-flight edits remain dirty.
        baseline = JSON.stringify({ name: savedName, state }); retry = false;
        document.title = `${currentAnalysis!.name} · WFS analysis`;
        status.textContent = dockStatus.textContent = 'Analysis configuration saved';
    };
    bar.append(back, name);
    if (!doc?.readOnly) {
        const saveButton = action('Save analysis', save); saveButton.id = 'saveSettings'; saveButton.className = 'primary'; bar.append(saveButton);
        dockButton.textContent = 'Save analysis'; dockButton.onclick = () => saveButton.click();
    }
    if (doc) {
        const copyButton = action('Save a copy', async () => {
            const state = await saveLocal(); rememberBindings(state.settings);
            const copy = await createAnalysis(name.value.trim().slice(0, 113) + ' (copy)', state);
            location.href = '/?analysis=' + encodeURIComponent(copy.id) + location.hash;
        });
        bar.append(copyButton);
        if (doc.readOnly) { copyButton.id = 'saveSettings'; dockButton.textContent = 'Save a copy'; dockButton.onclick = () => copyButton.click(); }
        if (!doc.readOnly) {
            bar.append(action('Share', async () => {
                await save();
                const share = await api<{ token: string }>(`/analyses/${doc.id}/share`, 'POST');
                link.value = new URL('/?share=' + share.token, location.href).href; link.hidden = false;
                try { await navigator.clipboard.writeText(link.value); status.textContent = 'Share link copied · recipient must authenticate and attach local CSVs'; }
                catch { link.select(); status.textContent = 'Copy this link to share the setup'; }
            }));
            bar.append(action('Stop sharing', async () => { await api(`/analyses/${doc.id}/share`, 'DELETE'); link.hidden = true; status.textContent = 'Share link revoked'; }));
        }
    }
    bar.append(link, status); host.append(bar); refresh();
}
