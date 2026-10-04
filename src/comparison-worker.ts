import { compare, relate, type Projection, type ComparisonResult, type RelationshipResult } from './comparison.ts';
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const comparisons = new Map<string, ComparisonResult>(), relationships = new Map<string, RelationshipResult>();
let revision = 0;
ctx.onmessage = event => {
    const m = event.data;
    if (m.type === 'reset') { revision++; comparisons.clear(); relationships.clear(); }
    if (m.type === 'compare' || m.type === 'relate') {
        const r = revision;
        const task = m.type === 'compare' ? compare(m.spec, new Map(m.data), () => r !== revision) : relate(m.spec, m.left, m.right, () => r !== revision);
        void task.then(result => {
            if (r !== revision) return;
            if (m.type === 'compare') { const value = result as ComparisonResult; comparisons.set(m.spec.id, value); ctx.postMessage({ type: 'compared', token: m.token, id: m.spec.id, result: { edges: value.edges, series: value.series.map(({ members, ...series }) => series) } }); }
            else { const value = result as RelationshipResult; relationships.set(m.spec.id, value); const { pairs, ...summary } = value; ctx.postMessage({ type: 'related', token: m.token, id: m.spec.id, result: summary }); }
        }).catch(e => { if (r === revision) ctx.postMessage({ type: 'error', id: m.spec.id, token: m.token, message: (e as Error).message }); });
    }
    if (m.type === 'pick') {
        const result = comparisons.get(m.id), series = result?.series.find(s => s.id === m.series);
        ctx.postMessage({ type: 'refs', token: m.token, refs: (series?.members[m.bin] ?? []).map(index => ({ sourceId: series!.sourceId, index })) });
    }
    if (m.type === 'relatedRefs') {
        const pairs = relationships.get(m.id)?.pairs ?? [], fromLeft = m.ref.sourceId === m.spec.leftSource;
        ctx.postMessage({ type: 'refs', token: m.token, refs: pairs.filter(pair => pair[fromLeft ? 0 : 1] === m.ref.index).map(pair => ({ sourceId: fromLeft ? m.spec.rightSource : m.spec.leftSource, index: pair[fromLeft ? 1 : 0] })) });
    }
};
