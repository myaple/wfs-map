import type { Field, FieldKind } from './data.ts';
import { parseUTC, utcISO } from './time.ts';

export type ServerFilter = { field: string; kind: FieldKind; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'notnull'; value?: string };
export const serverOperators = (kind: FieldKind): ServerFilter['op'][] => ['eq', 'ne', ...(kind === 'number' || kind === 'date' ? ['gt', 'gte', 'lt', 'lte'] as const : []), ...(kind === 'string' ? ['contains'] as const : []), 'null', 'notnull'];
export function filterLiteral(rule: ServerFilter): string {
    const v = rule.value ?? '';
    if (rule.kind === 'string') return v;
    if (rule.kind === 'number') {
        if (!v.trim() || !Number.isFinite(Number(v))) throw Error(`Enter a finite number for "${rule.field}".`);
        return String(Number(v));
    }
    if (rule.kind === 'boolean') {
        if (!['true', 'false'].includes(v)) throw Error(`Choose true or false for "${rule.field}".`);
        return v;
    }
    if (!Number.isFinite(parseUTC(v))) throw Error(`Enter a valid UTC date/time for "${rule.field}".`);
    return utcISO(v);
}
export function validateServerFilters(input: unknown, fields?: Field[]): asserts input is ServerFilter[] {
    if (!Array.isArray(input) || input.length > 100) throw Error('Advanced server filters must contain at most 100 rules.');
    for (const r of input) {
        if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['field', 'kind', 'op', 'value'].includes(k)) || typeof r.field !== 'string' || !r.field.trim() || r.field.length > 8192
            || !['string', 'number', 'boolean', 'date'].includes(r.kind) || !serverOperators(r.kind).includes(r.op) || (r.value !== undefined && (typeof r.value !== 'string' || r.value.length > 8192))) throw Error('Invalid advanced server filter rule.');
        if (fields && !fields.some(f => f.name === r.field && f.kind === r.kind)) throw Error(`Advanced server filter field "${r.field}" is missing or its type changed. Read available fields and update the rule.`);
        if (r.op !== 'null' && r.op !== 'notnull') {
            if (typeof r.value !== 'string') throw Error('Enter a value for the advanced server filter.');
            filterLiteral(r);
        }
    }
}
/** Compile once; excluded rows never enter the column store or map buffers. */
export function serverPredicate(rules: ServerFilter[], fields: Field[]): (properties: Record<string, unknown>) => boolean {
    validateServerFilters(rules, fields);
    const tests = rules.map(r => {
        const literal = r.op === 'null' || r.op === 'notnull' ? '' : filterLiteral(r);
        const convert = (v: unknown): string | number | boolean => r.kind === 'number' ? Number(v) : r.kind === 'date' ? parseUTC(String(v)) : r.kind === 'boolean' ? v === true || v === 'true' : String(v);
        const expected = convert(literal);
        return (p: Record<string, unknown>) => {
            const raw = p[r.field], missing = raw === null || raw === undefined;
            if (r.op === 'null') return missing;
            if (r.op === 'notnull') return !missing;
            if (missing) return false;
            const actual = convert(raw);
            switch (r.op) {
                case 'eq': return actual === expected;
                case 'ne': return actual !== expected;
                case 'gt': return actual > expected;
                case 'gte': return actual >= expected;
                case 'lt': return actual < expected;
                case 'lte': return actual <= expected;
                case 'contains': return String(actual).includes(String(expected));
            }
        };
    });
    return p => tests.every(test => test(p));
}
