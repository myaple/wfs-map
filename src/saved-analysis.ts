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
export function mountAnalysisControls(snapshot: () => AnalysisState | Promise<AnalysisState>) {
    const doc = currentAnalysis;
    if (!doc) return;
    const bar = document.createElement('section'); bar.className = 'saved-analysis-bar';
    const back = document.createElement('a'); back.href = '/'; back.textContent = 'All analyses';
    const name = document.createElement('input'); name.value = doc.name; name.maxLength = 120; name.setAttribute('aria-label', 'Analysis name'); name.readOnly = doc.readOnly;
    document.title = `${doc.name} · WFS analysis`;
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.className = 'hint'; status.textContent = doc.readOnly ? 'Shared setup · changes stay local until you save a copy' : 'Configuration saved remotely · CSV contents stay on this workstation';
    const link = document.createElement('input'); link.readOnly = true; link.hidden = true; link.setAttribute('aria-label', 'Shared analysis link');
    let busy = false;
    const buttons: HTMLButtonElement[] = [];
    const action = (label: string, run: () => Promise<void>) => {
        const button = document.createElement('button'); button.textContent = label; buttons.push(button);
        button.onclick = async () => {
            if (busy) return; busy = true; buttons.forEach(b => b.disabled = true); status.textContent = 'Saving configuration…';
            try { await run(); } catch (e) { status.textContent = (e as Error).message; } finally { busy = false; buttons.forEach(b => b.disabled = false); }
        };
        return button;
    };
    const save = async () => { const state = await snapshot(); rememberBindings(state.settings); currentAnalysis = await saveAnalysis(currentAnalysis!, name.value.trim(), state); document.title = `${currentAnalysis.name} · WFS analysis`; status.textContent = 'Analysis configuration saved'; };
    bar.append(back, name);
    if (!doc.readOnly) bar.append(action('Save analysis', save));
    bar.append(action('Save a copy', async () => {
        const state = await snapshot(); rememberBindings(state.settings);
        const copy = await createAnalysis(name.value.trim().slice(0, 113) + ' (copy)', state);
        location.href = '/?analysis=' + encodeURIComponent(copy.id) + location.hash;
    }));
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
    document.querySelector('.topbar')!.after(bar);
}
