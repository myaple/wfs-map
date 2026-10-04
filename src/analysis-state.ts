import type { ComparisonSpec, RelationshipSpec } from './comparison.ts';
import { configKeys, defaultConfig, type Settings } from './source-settings.ts';
import type { Field } from './data.ts';
import type { ChartSpec, Expression } from './analysis.ts';
import type { QueryBounds } from './wfs-query.ts';
export type SourceAnalysis = { id: string; fields: Field[]; expression: Expression; charts: ChartSpec[] };
export type AnalysisState = { schemaVersion: 1; settings: Settings; query: { choice: string; bounds: QueryBounds }; analyses: SourceAnalysis[]; comparisons?: ComparisonSpec[]; relationships?: RelationshipSpec[] };
export type AnalysisDocument = { id: string; name: string; state: AnalysisState; revision: number; updatedAt: string; readOnly: boolean; shared: boolean };
export type AnalysisSummary = Omit<AnalysisDocument, 'state' | 'readOnly'>;
export function shareExpression(expression: Expression): Expression {
    // Observation indices are tied to one local load. Reject saving rather than
    // silently discarding other predicates or changing AND/OR semantics.
    const hasRow = (e: Expression): boolean => e.op === 'row' || ('children' in e && e.children.some(hasRow));
    if (hasRow(expression)) throw Error('Individual-observation selections cannot be saved. Remove those selection chips from Dataset filters, then save again. Your other filters and current selection have not changed.');
    return structuredClone(expression);
}
export function configurationState(settings: Settings, query: AnalysisState['query'], analyses: SourceAnalysis[], extra: { comparisons?: ComparisonSpec[]; relationships?: RelationshipSpec[] } = {}): AnalysisState {
    return {
        schemaVersion: 1,
        ...(extra.comparisons?.length ? { comparisons: extra.comparisons.map(c => ({ id: c.id, name: c.name, kind: c.kind, unit: c.unit, bins: c.bins, bucketMs: c.bucketMs, aggregate: c.aggregate, series: c.series.map(s => ({ id: s.id, sourceId: s.sourceId, label: s.label, x: s.x, ...(s.y ? { y: s.y } : {}), unit: s.unit, scale: s.scale, offset: s.offset, converted: s.converted, filter: shareExpression(s.filter) })) })) } : {}),
        ...(extra.relationships?.length ? { relationships: extra.relationships.map(r => ({ id: r.id, name: r.name, leftSource: r.leftSource, rightSource: r.rightSource, match: r.match, ...(r.identifier ? { identifier: { left: r.identifier.left, right: r.identifier.right } } : {}), ...(r.time ? { time: { left: r.time.left, right: r.time.right, toleranceMs: r.time.toleranceMs } } : {}), ...(r.spatial ? { spatial: { radiusMetres: r.spatial.radiusMetres } } : {}) })) } : {}),
        settings: {
            sources: settings.sources.map(s => ({
                id: s.id, name: s.name, enabled: s.enabled,
                config: Object.fromEntries(configKeys.filter(k => k !== 'csvText').map(k => [k, s.config[k]])) as Settings['sources'][number]['config'],
                ...(s.color ? { color: [...s.color] as [number, number, number] } : {}),
                ...(s.coloring ? { coloring: { field: s.coloring.field, bins: s.coloring.bins, low: s.coloring.low, high: s.coloring.high, ...(s.coloring.categories ? { categories: structuredClone(s.coloring.categories) } : {}) } } : {})
            })),
            background: { url: settings.background.url, attribution: settings.background.attribution, enabled: settings.background.enabled },
            ...(settings.map ? { map: { center: [...settings.map.center] as [number, number], zoom: settings.map.zoom, pointSize: settings.map.pointSize } } : {})
        },
        query: { choice: query.choice, bounds: structuredClone(query.bounds) },
        analyses: analyses.map(s => ({ id: s.id, fields: s.fields.map(f => ({ name: f.name, kind: f.kind })), expression: shareExpression(s.expression), charts: s.charts.map(c => ({ id: c.id, type: c.type, x: c.x, ...(c.y !== undefined ? { y: c.y } : {}), bins: c.bins, ...(c.binned !== undefined ? { binned: c.binned } : {}), ...(c.aggregate ? { aggregate: c.aggregate } : {}) })) }))
    };
}
export function localSettings(state: AnalysisState): Settings {
    if (state.schemaVersion !== 1) throw Error('Unsupported analysis version.');
    return { ...structuredClone(state.settings), sources: state.settings.sources.map(s => ({ ...structuredClone(s), config: { ...defaultConfig, ...s.config, csvText: '' } })) };
}
export function emptyState(): AnalysisState {
    return configurationState({ sources: [], background: { url: '', attribution: '', enabled: false } }, { choice: '24', bounds: {} }, []);
}
