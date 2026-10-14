import type { Config } from './source-settings.ts';
export const inferredFieldKeys = ['timeField', 'latitudeField', 'longitudeField', 'ellipseMajorField', 'ellipseMinorField', 'ellipseOrientationField', 'ellipseMajorUnit', 'ellipseMinorUnit'] as const;
type Key = typeof inferredFieldKeys[number];
export type CsvInference = { available: boolean; fields: Partial<Record<Key, { value: string | null; probability: number; candidates: { value: string | null; probability: number }[] }>> };
/** Optional metadata-only API; bounded independently of the main workspace API. */
export async function inferCSVFields(columns: string[], signal: AbortSignal): Promise<CsvInference | undefined> {
    if (!columns.length || columns.length > 254 || columns.some(c => new TextEncoder().encode(c).length > 256)) return;
    try {
        const response = await fetch('/api/csv/infer-fields', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]), headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1' }, body: JSON.stringify({ columns }) });
        if (!response.ok) return;
        const result: CsvInference = await response.json();
        if (result.available === true && result.fields && typeof result.fields === 'object') return result;
    } catch { /* Disabled, offline, failed, expired and cancelled all retain local mappings. */ }
}
/** Validate server output against this file; apply only untouched, unsaved controls. */
export function csvInferencePatch(result: CsvInference, columns: string[], before: Config, current: Config, saved?: Config, touched: ReadonlySet<Key> = new Set()): Partial<Config> {
    const patch: Partial<Config> = {};
    const writable = (key: Key) => !touched.has(key) && current[key] === before[key] && !(saved && (key.endsWith('Unit') || saved[key]));
    for (const key of inferredFieldKeys) {
        const p = result.fields[key];
        if (!p || typeof p.value !== 'string' || !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1 || !writable(key)) continue;
        if (key.endsWith('Unit') ? !['m', 'nm'].includes(p.value) : !columns.includes(p.value)) continue;
        // Units must correspond to the axis the model selected, not a saved/manual axis.
        if (key.endsWith('Unit')) {
            const field = key === 'ellipseMajorUnit' ? 'ellipseMajorField' : 'ellipseMinorField';
            if (touched.has(field) || (patch[field] ?? current[field]) !== result.fields[field]?.value) continue;
        }
        patch[key] = p.value;
    }
    const fields = ['timeField', 'latitudeField', 'longitudeField', 'ellipseMajorField', 'ellipseMinorField', 'ellipseOrientationField'] as const;
    const proposed = { ...current, ...patch };
    for (const key of fields) if (patch[key] && fields.some(other => other !== key && proposed[other] === patch[key])) delete patch[key];
    for (const [unit, field] of [['ellipseMajorUnit', 'ellipseMajorField'], ['ellipseMinorUnit', 'ellipseMinorField']] as const) {
        if ((patch[field] ?? current[field]) !== result.fields[field]?.value) delete patch[unit];
    }
    const ellipse = ['ellipseMajorField', 'ellipseMinorField', 'ellipseOrientationField'] as const;
    // A partial ellipse would make the existing source form invalid. Keep its prior state.
    if (!ellipse.every(key => (patch[key] ?? current[key]))) {
        for (const key of [...ellipse, 'ellipseMajorUnit', 'ellipseMinorUnit'] as const) delete patch[key];
    }
    return patch;
}
