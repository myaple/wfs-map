import { formatUTC } from './time.ts';
import './style.css';
import { mountPageBanners } from './page-banners.ts';
import { createAnalysis, getAnalysis, listAnalyses, api, saveAnalysis } from './analyses-api.ts';
import { emptyState, configurationState } from './analysis-state.ts';
import { prepareAnalysis } from './saved-analysis.ts';
import { readSettings } from './source-settings.ts';
const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
async function selector() {
    root.replaceChildren(); document.title = 'My analyses · WFS analysis';
    const header = el('header'); header.className = 'topbar'; header.append(el('h1', 'My analyses'));
    const body = el('section'); body.className = 'analyses-selector';
    body.append(el('p', 'Save an analysis setup, resume your work, or share it with a colleague. CSV contents stay on your workstation.'));
    const form = el('form'); form.className = 'row';
    const name = el('input'); name.placeholder = 'Analysis name'; name.required = true; name.maxLength = 120; name.setAttribute('aria-label', 'New analysis name');
    const create = el('button', 'Create analysis'); create.type = 'submit'; create.className = 'primary';
    const fromBrowser = el('input'); fromBrowser.type = 'checkbox';
    const fromLabel = el('label', 'Start with this browser’s sources and map'); fromLabel.prepend(fromBrowser);
    const status = el('p'); status.setAttribute('role', 'status');
    const list = el('div'); list.className = 'analysis-list';
    body.append(form, status, list); form.append(name, create, fromLabel); root.append(header, body);
    form.onsubmit = async event => {
        event.preventDefault(); create.disabled = true;
        try {
            const state = fromBrowser.checked ? configurationState(readSettings(), { choice: '24', bounds: {} }, []) : emptyState();
            const doc = await createAnalysis(name.value.trim(), state); location.href = '/?analysis=' + doc.id;
        } catch (e) { status.textContent = (e as Error).message; } finally { create.disabled = false; }
    };
    try {
        const docs = await listAnalyses();
        if (!docs.length) list.append(el('p', 'No saved analyses yet. Create one to get started.'));
        for (const doc of docs) {
            const card = el('article'); card.className = 'analysis-card';
            const title = el('h2', doc.name);
            const details = el('p', `Saved ${formatUTC(doc.updatedAt)}${doc.shared ? ' · shared' : ''}`); details.className = 'hint';
            const links = el('div'); links.className = 'row';
            const open = el('a', 'Open analysis'); open.href = '/?analysis=' + doc.id + '#analysis';
            const sources = el('a', 'Data sources'); sources.href = '/?analysis=' + doc.id + '#configuration';
            const tab = el('a', 'Open in new tab'); tab.href = open.href; tab.target = '_blank'; tab.rel = 'noopener';
            const rename = el('button', 'Rename');
            rename.onclick = async () => { const next = prompt('Analysis name', doc.name)?.trim(); if (!next) return; rename.disabled = true; try { const full = await getAnalysis(doc.id); await saveAnalysis(full, next, full.state); await selector(); } catch (e) { status.textContent = (e as Error).message; rename.disabled = false; } };
            const remove = el('button', 'Delete');
            remove.onclick = async () => { if (!confirm(`Delete “${doc.name}” and its share link? Local CSV files are retained.`)) return; remove.disabled = true; try { await api('/analyses/' + doc.id, 'DELETE'); await selector(); } catch (e) { status.textContent = (e as Error).message; remove.disabled = false; } };
            links.append(open, sources, tab, rename, remove); card.append(title, details, links); list.append(card);
        }
    } catch (e) {
        status.textContent = (e as Error).message;
        const retry = el('button', 'Retry'); retry.onclick = () => void selector();
        const local = el('a', 'Open a local analysis'); local.href = '/?local=1'; body.append(retry, local);
    }
}
async function start() {
    const id = params.get('analysis'), shared = params.get('share');
    if (id || shared) {
        root.textContent = 'Opening analysis…';
        try {
            const [doc, identity] = await Promise.all([getAnalysis((id ?? shared)!, !!shared), api<{ user: string }>('/me')]);
            await prepareAnalysis(doc, identity.user);
            await import('./analysis-page.ts');
        } catch (e) { root.replaceChildren(el('p', (e as Error).message)); const back = el('a', 'All analyses'); back.href = '/'; root.append(back); }
    } else if (params.has('local') || params.has('autoload') || params.has('points') || params.has('url') || params.has('time') || location.hash === '#configuration' || location.hash === '#analysis') {
        await import('./analysis-page.ts');
    } else await selector();
}
await mountPageBanners();
await start();
