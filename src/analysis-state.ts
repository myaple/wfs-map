import { configKeys, defaultConfig, type Settings } from './source-settings.ts';
import type { Field } from './data.ts';
import type { ChartSpec, Expression } from './analysis.ts';
import type { TimeWindow } from './timeline-data.ts';
import type { QueryBounds, MapBounds } from './wfs-query.ts';
export type SourceAnalysis = { id: string; fields: Field[]; expression: Expression; charts: ChartSpec[] };
export type AnalysisState = { schemaVersion: 1; settings: Settings; query: { choice: string; bounds: QueryBounds }; analyses: SourceAnalysis[]; timeline?: TimeWindow; localMapBounds?: MapBounds };
export type AnalysisDocument = { id: string; name: string; state: AnalysisState; revision: number; updatedAt: string; readOnly: boolean; shared: boolean };
export type AnalysisSummary = Omit<AnalysisDocument, 'state' | 'readOnly'>;
export function shareExpression(expression: Expression): Expression {
    // Observation indices are tied to one local load. Reject saving rather than
    // silently discarding other predicates or changing AND/OR semantics.
    const hasRow = (e: Expression): boolean => e.op === 'row' || ('children' in e && e.children.some(hasRow));
    if (hasRow(expression)) throw Error('Individual-observation selections cannot be saved. Remove those selection chips from Dataset filters, then save again. Your other filters and current selection have not changed.');
    return structuredClone(expression);
}
export function configurationState(settings: Settings, query: AnalysisState['query'], analyses: SourceAnalysis[], timeline?: TimeWindow, localMapBounds?: MapBounds): AnalysisState {
    return {
        schemaVersion: 1,
        ...(localMapBounds ? { localMapBounds: { west: localMapBounds.west, east: localMapBounds.east, south: localMapBounds.south, north: localMapBounds.north } } : {}),
        ...(timeline ? { timeline: { ...timeline } } : {}),
        settings: {
            sources: settings.sources.map(s => ({
                id: s.id, name: s.name, enabled: s.enabled,
                serverFilters: structuredClone(s.serverFilters ?? []),
                config: Object.fromEntries(configKeys.filter(k => k !== 'csvText').map(k => [k, s.config[k]])) as Settings['sources'][number]['config'],
                ...(s.color ? { color: [...s.color] as [number, number, number] } : {}),
                ...(s.coloring ? { coloring: { ...(s.coloring.scale ? { scale: s.coloring.scale } : {}), field: s.coloring.field, bins: s.coloring.bins, low: s.coloring.low, high: s.coloring.high, ...(s.coloring.categories ? { categories: structuredClone(s.coloring.categories) } : {}) } } : {})
            })),
            background: { url: settings.background.url, attribution: settings.background.attribution, enabled: settings.background.enabled },
            ...(settings.map ? { map: { center: [...settings.map.center] as [number, number], zoom: settings.map.zoom, pointSize: settings.map.pointSize } } : {})
        },
        query: { choice: query.choice, bounds: structuredClone(query.bounds) },
        analyses: analyses.map(s => ({ id: s.id, fields: s.fields.map(f => ({ name: f.name, kind: f.kind })), expression: shareExpression(s.expression), charts: s.charts.map(c => ({ id: c.id, type: c.type, x: c.x, ...(c.y !== undefined ? { y: c.y } : {}), bins: c.bins, ...(c.pointSize !== undefined ? { pointSize: c.pointSize } : {}), ...(c.hiddenSources?.length ? { hiddenSources: [...c.hiddenSources] } : {}), ...(c.xScale ? { xScale: c.xScale } : {}), ...(c.yScale ? { yScale: c.yScale } : {}), ...(c.binned !== undefined ? { binned: c.binned } : {}), ...(c.aggregate ? { aggregate: c.aggregate } : {}), ...(c.series?.length ? { series: c.series.map(s => ({ sourceId: s.sourceId, x: s.x, ...(s.y !== undefined ? { y: s.y } : {}) })) } : {}) })) }))
    };
}
export function localSettings(state: AnalysisState): Settings {
    if (state.schemaVersion !== 1) throw Error('Unsupported analysis version.');
    return { ...structuredClone(state.settings), sources: state.settings.sources.map(s => ({ ...structuredClone(s), config: { ...defaultConfig, ...s.config, csvText: '' } })) };
}
export function emptyState(): AnalysisState {
    return configurationState({ sources: [], background: { url: '', attribution: '', enabled: false } }, { choice: '24', bounds: {} }, []);
}
