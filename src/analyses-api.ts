import type { AnalysisDocument, AnalysisState, AnalysisSummary } from './analysis-state.ts';
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch('/api' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Workspace-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
        // Only controlled API messages are displayed; never HTML returned by a gateway.
        const text = await response.text();
        throw Error(response.status === 401 ? 'Your authenticated user identity is required to open saved analyses.' : response.status === 409 ? 'A newer version was saved in another tab. Reopen this analysis or save a copy.' : text.startsWith('<') ? `Workspace service unavailable (${response.status}).` : text.slice(0, 300) || `Workspace request failed (${response.status}).`);
    }
    return response.json();
}
export const listAnalyses = () => api<AnalysisSummary[]>('/analyses');
export const getAnalysis = (id: string, shared = false) => api<AnalysisDocument>((shared ? '/shared/' : '/analyses/') + encodeURIComponent(id));
export const createAnalysis = (name: string, state: AnalysisState) => api<AnalysisDocument>('/analyses', 'POST', { name, state });
export const saveAnalysis = (doc: AnalysisDocument, name: string, state: AnalysisState) => api<AnalysisDocument>('/analyses/' + encodeURIComponent(doc.id), 'PUT', { name, state, revision: doc.revision });
