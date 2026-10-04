import type { Config } from './source-settings.ts';
import type { Field } from './data.ts';
export type CSVKind = Field['kind'];
export const csvOptionDefaults = { csvTypes: '{}', csvMissingValues: '["","N/A","NA","NULL"]', csvInvalidRows: 'reject' };
export function csvOptions(config: Config) {
    const types: unknown = JSON.parse(config.csvTypes ?? csvOptionDefaults.csvTypes);
    const tokens: unknown = JSON.parse(config.csvMissingValues ?? csvOptionDefaults.csvMissingValues);
    const policy = config.csvInvalidRows ?? 'reject';
    if (!types || typeof types !== 'object' || Array.isArray(types) || Object.values(types).some(v => typeof v !== 'string' || !['string', 'number', 'boolean', 'date'].includes(v))) throw Error('Invalid CSV column type overrides.');
    if (!Array.isArray(tokens) || tokens.some(v => typeof v !== 'string')) throw Error('CSV missing values must be a list of text tokens.');
    if (!['reject', 'quarantine'].includes(policy)) throw Error('Choose reject-all or quarantine for invalid CSV rows.');
    // Blanks are always missing. Other tokens are trimmed and case sensitive.
    return { types: Object.assign(Object.create(null), types) as Record<string, CSVKind>, missing: new Set(['', ...tokens.map(v => v.trim())]), policy };
}
