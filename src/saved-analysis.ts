import { settingsKey, setSettingsScope, type Settings } from './source-settings.ts';
import { setFileUser } from './source-storage.ts';
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
export function mountAnalysisControls(snapshot: () => AnalysisState, host: HTMLElement, dock: HTMLElement, saveLocal: () => void) {
    const dockGroup = document.createElement('div'); dockGroup.className = 'dock-save';
    const dockStatus = document.createElement('span'); dockStatus.className = 'dock-save-status hint'; dockStatus.setAttribute('role', 'status');
    const dockButton = document.createElement('button'); dockButton.id = 'dockSaveAnalysis'; dockButton.className = 'primary'; dockButton.disabled = true;
    dockGroup.append(dockStatus, dockButton); dock.append(dockGroup);
    let baseline = '', busy = false;
    const fingerprint = (name = currentAnalysis?.name ?? '') => JSON.stringify({ name, state: snapshot() });
    try { baseline = fingerprint(); } catch {}
    let nameInput: HTMLInputElement | undefined;
    const refresh = () => {
        let dirty = true;
        try { dirty = fingerprint(nameInput?.value.trim()) !== baseline; } catch { /* Invalid drafts still require saving or correction. */ }
        dockButton.disabled = busy || !dirty;
        dockButton.title = dirty ? 'Save the current analysis configuration' : 'All analysis changes saved';
        if (!busy && !dirty) dockStatus.textContent = 'Saved';
        else if (!busy && dockStatus.textContent === 'Saved') dockStatus.textContent = 'Unsaved changes';
    };
    // Compare only portable metadata, never loaded rows or chart buffers. This also
    // catches asynchronous load defaults, map gestures and detached filter editors.
    window.setInterval(refresh, 500);
    let refreshFrame = 0;
    for (const event of ['input', 'change', 'click', 'analysischange']) window.addEventListener(event, () => {
        if (!refreshFrame) refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
    });
    const doc = currentAnalysis;
    const bar = document.createElement('section'); bar.className = 'saved-analysis-bar';
    const back = document.createElement('a'); back.href = '/'; back.textContent = 'All analyses';
    if (!doc) {
        const hint = document.createElement('p'); hint.className = 'hint';
        hint.textContent = 'Open or create a named analysis from All analyses to save remotely and share its setup.';
        bar.append(back, hint); host.append(bar);
        dockButton.textContent = 'Save analysis';
        dockButton.onclick = () => {
            try { saveLocal(); baseline = fingerprint(); dockStatus.textContent = 'Saved in this browser'; }
            catch (e) { dockStatus.textContent = (e as Error).message; }
            refresh();
        };
        refresh(); return;
    }
    const name = document.createElement('input'); name.value = doc.name; name.maxLength = 120; name.setAttribute('aria-label', 'Analysis name'); name.readOnly = doc.readOnly;
    nameInput = name;
    document.title = `${doc.name} · WFS analysis`;
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.className = 'hint'; status.textContent = doc.readOnly ? 'Shared setup · changes stay local until you save a copy' : 'Save your configuration remotely to resume or share it. CSV contents stay on this workstation.';
    const link = document.createElement('input'); link.readOnly = true; link.hidden = true; link.setAttribute('aria-label', 'Shared analysis link');
    const buttons: HTMLButtonElement[] = [];
    const action = (label: string, run: () => Promise<void>) => {
        const button = document.createElement('button'); button.textContent = label; buttons.push(button);
        button.onclick = async () => {
            if (busy) return; busy = true; buttons.forEach(b => b.disabled = true); status.textContent = dockStatus.textContent = 'Saving configuration…'; dockButton.disabled = true;
            try { await run(); } catch (e) { status.textContent = dockStatus.textContent = (e as Error).message; } finally { busy = false; buttons.forEach(b => b.disabled = false); refresh(); }
        };
        return button;
    };
    const save = async () => {
        const state = snapshot(), savedName = name.value.trim();
        rememberBindings(state.settings);
        currentAnalysis = await saveAnalysis(currentAnalysis!, savedName, state);
        // Changes made while the request was in flight remain dirty.
        baseline = JSON.stringify({ name: savedName, state });
        document.title = `${currentAnalysis.name} · WFS analysis`;
        status.textContent = dockStatus.textContent = 'Analysis configuration saved';
    };
    bar.append(back, name);
    if (!doc.readOnly) {
        const remoteSave = action('Save analysis', save); bar.append(remoteSave);
        dockButton.textContent = 'Save analysis'; dockButton.onclick = () => remoteSave.click();
    }
    const copyButton = action('Save a copy', async () => {
        const state = snapshot(); rememberBindings(state.settings);
        const copy = await createAnalysis(name.value.trim().slice(0, 113) + ' (copy)', state);
        location.href = '/?analysis=' + encodeURIComponent(copy.id) + location.hash;
    });
    bar.append(copyButton);
    if (doc.readOnly) { dockButton.textContent = 'Save a copy'; dockButton.onclick = () => copyButton.click(); }
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
    bar.append(link, status);
    host.append(bar);
    refresh();
}
