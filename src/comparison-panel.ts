import { createUUID } from './uuid.ts';
import { formatUTC } from './time.ts';
import { themeColor } from './theme.ts';
import type { ComparisonSpec, ComparisonResult, Projection, RelationshipSpec, RelationshipResult, SeriesSpec } from './comparison.ts';
import type { RecordRef } from './records.ts';
import type { RecordsSource } from './records-page.ts';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
const button = (label: string, run: () => void) => { const b = el('button', label); b.type = 'button'; b.onclick = run; return b; };
const input = (value = '', type = 'text') => { const n = el('input'); n.type = type; n.value = value; return n; };
const select = (options: [string, string][]) => { const n = el('select'); n.append(...options.map(([v, label]) => new Option(label, v))); return n; };
let control = 0;
function field(label: string, node: HTMLElement) { const root = el('div'), title = el('label', label); root.className = 'comparison-field'; node.id = `comparison-control-${++control}`; title.htmlFor = node.id; root.append(title, node); return root; }
type Card = { root: HTMLElement; status: HTMLElement; output: HTMLElement };
export class ComparisonPanel {
    comparisons: ComparisonSpec[]; relationships: RelationshipSpec[];
    private worker = new Worker(new URL('./comparison-worker.ts', import.meta.url), { type: 'module' });
    private epoch = 0; private token = 0; private timer?: ReturnType<typeof setTimeout>;
    private pending = new Map<string, { kind: 'compare' | 'relate'; spec: ComparisonSpec | RelationshipSpec; data: Map<string, Projection>; needed: number }>();
    private cards = new Map<string, Card>(); private comparisonList = el('div'); private relationshipList = el('div');
    private comparisonForm = el('form'); private relationshipForm = el('form');
    private selected?: RecordRef;
    private related = el('div');
    private updateComparisonFields?: () => void; private updateRelationshipFields?: () => void;
    private rendered = new Map<string, () => void>();
    constructor(private sources: () => RecordsSource[], private send: (id: string, message: unknown) => void, private choose: (refs: RecordRef[]) => void, saved: { comparisons?: ComparisonSpec[]; relationships?: RelationshipSpec[] }, private changed: () => void) {
        this.comparisons = structuredClone(saved.comparisons ?? []); this.relationships = structuredClone(saved.relationships ?? []);
        const comparisons = el('section'); comparisons.className = 'comparison-panel'; comparisons.id = 'comparisonPanel';
        comparisons.append(el('h2', 'Source comparisons'), el('p', 'Compare applied results on shared axes. Map/time bounds and applied dataset filters remain in force; each series can add its own filter. Declare units and conversions explicitly.'), this.comparisonForm, this.comparisonList);
        document.getElementById('analysis')!.append(comparisons);
        const relationships = el('section'); relationships.className = 'comparison-panel'; relationships.id = 'relationshipPanel';
        relationships.append(el('h2', 'Record relationships'), el('p', 'Match two applied source results. Enabled rules use AND. Null identifiers and times never match. Saved rules contain configuration only; previews and links remain local.'), this.relationshipForm, this.related, this.relationshipList);
        document.getElementById('records')!.append(relationships);
        this.buildComparison(); this.buildRelationship(); this.mountCards();
        this.worker.onmessage = event => this.result(event.data);
        window.addEventListener('recordinspection', e => { this.selected = (e as CustomEvent).detail ?? undefined; this.showRelated(); });
        window.addEventListener('themechange', () => { for (const draw of this.rendered.values()) draw(); });
    }
    private sourceOptions() { return this.sources().filter(s => s.enabled).map(s => [s.id, s.name] as [string, string]); }
    private source(id: string) { return this.sources().find(s => s.id === id && s.enabled); }
    private populate(node: HTMLSelectElement, id: string, kinds?: string[], includeId = false, previous = node.value) {
        node.replaceChildren(...(includeId ? [new Option('Feature ID', '@id')] : []), ...(this.source(id)?.fields.filter(f => !kinds || kinds.includes(f.kind)) ?? []).map(f => new Option(`${f.name} (${f.kind})`, f.name)));
        if ([...node.options].some(o => o.value === previous)) node.value = previous;
    }
    private buildComparison(saved?: ComparisonSpec) {
        this.comparisonForm.replaceChildren(); this.comparisonForm.className = 'comparison-editor';
        const name = input(saved?.name ?? 'Source comparison'), kind = select([['histogram', 'Shared histogram'], ['time', 'UTC time series']]), unit = input(saved?.unit ?? '', 'text'), bins = input(String(saved?.bins ?? 24), 'number'), bucket = input(String((saved?.bucketMs ?? 3600000) / 1000), 'number'), aggregate = select([['count', 'Record count'], ['mean', 'Mean'], ['sum', 'Sum'], ['min', 'Minimum'], ['max', 'Maximum']]);
        kind.value = saved?.kind ?? 'histogram'; aggregate.value = saved?.aggregate ?? 'mean'; bins.min = '2'; bins.max = '128'; bucket.min = '.001'; bucket.step = 'any'; unit.placeholder = 'e.g. °C, metres, or dimensionless'; unit.required = true; name.required = true;
        const controls = el('div'); controls.className = 'comparison-controls'; controls.append(field('Comparison name', name), field('Comparison type', kind), field('Common measure unit', unit), field('Common bins', bins), field('UTC bucket duration (seconds)', bucket), field('Time aggregation', aggregate));
        const seriesList = el('div'), seriesForms: { root: HTMLElement; read: () => SeriesSpec; update: () => void }[] = [];
        const addSeries = (spec?: SeriesSpec) => {
            if (seriesForms.length >= 8) return;
            const root = el('fieldset'); root.className = 'comparison-series'; const legend = el('legend', `Series ${seriesForms.length + 1}`);
            const source = select(this.sourceOptions()), label = input(spec?.label ?? ''), x = el('select'), y = el('select'), measureUnit = input(spec?.unit ?? ''), scale = input(String(spec?.scale ?? 1), 'number'), offset = input(String(spec?.offset ?? 0), 'number'), converted = input('', 'checkbox'), filter = el('textarea');
            scale.step = offset.step = 'any'; converted.checked = spec?.converted ?? false; filter.value = JSON.stringify(spec?.filter ?? { op: 'and', children: [] }); filter.rows = 2; filter.spellcheck = false;
            if (spec) source.value = spec.sourceId; else if (seriesForms.length) source.value = this.sourceOptions()[Math.min(seriesForms.length, this.sourceOptions().length - 1)]?.[0] ?? '';
            const update = () => { this.populate(x, source.value, kind.value === 'time' ? ['date'] : ['number']); this.populate(y, source.value, ['number']); y.parentElement!.hidden = kind.value !== 'time' || aggregate.value === 'count'; label.placeholder = this.source(source.value)?.name ?? 'Series label'; if (kind.value === 'time' && aggregate.value === 'count') { measureUnit.value = 'records'; scale.value = '1'; offset.value = '0'; converted.checked = false; } };
            const remove = button('Remove series', () => { root.remove(); seriesForms.splice(seriesForms.indexOf(entry), 1); });
            root.append(legend, field('Series source', source), field('Series label', label), field('Mapped X field', x), field('Mapped measure field', y), field('Series measure unit', measureUnit), field('Convert explicitly: common = value × scale + offset', converted), field('Conversion scale', scale), field('Conversion offset', offset), field('Additional series filter (JSON)', filter), remove);
            const entry = { root, update, read: (): SeriesSpec => ({ id: spec?.id ?? createUUID(), sourceId: source.value, label: label.value.trim() || this.source(source.value)?.name || source.value, x: x.value, ...(kind.value === 'time' && aggregate.value !== 'count' ? { y: y.value } : {}), unit: measureUnit.value.trim(), scale: Number(scale.value), offset: Number(offset.value), converted: converted.checked, filter: JSON.parse(filter.value) }) };
            seriesForms.push(entry); seriesList.append(root); source.onchange = update; update(); if (spec) { x.value = spec.x; y.value = spec.y ?? ''; }
        };
        const update = () => { if (kind.value === 'time' && aggregate.value === 'count') unit.value = 'records'; bins.parentElement!.hidden = kind.value === 'time'; bucket.parentElement!.hidden = aggregate.parentElement!.hidden = kind.value !== 'time'; for (const entry of seriesForms) entry.update(); };
        kind.onchange = aggregate.onchange = update; this.updateComparisonFields = update;
        const submit = el('button', saved ? 'Update comparison' : 'Create comparison'); submit.type = 'submit'; const status = el('p'); status.setAttribute('role', 'status');
        this.comparisonForm.append(controls, seriesList, button('Add comparison series', () => addSeries()), submit, status);
        for (const series of saved?.series ?? [undefined, undefined]) addSeries(series); update();
        this.comparisonForm.onsubmit = e => {
            e.preventDefault();
            try {
                const spec: ComparisonSpec = { id: saved?.id ?? createUUID(), name: name.value.trim(), kind: kind.value as ComparisonSpec['kind'], unit: unit.value.trim(), bins: Number(bins.value), bucketMs: Number(bucket.value) * 1000, aggregate: aggregate.value as ComparisonSpec['aggregate'], series: seriesForms.map(entry => entry.read()) };
                if (spec.series.length < 2 || spec.series.some(s => !s.x || !s.unit)) throw Error('Choose mapped fields and declare units for at least two series.');
                if (spec.series.some(s => s.unit !== spec.unit && !s.converted || !s.converted && (s.scale !== 1 || s.offset !== 0))) throw Error('Different units require an explicit conversion.');
                if (!saved && this.comparisons.length >= 12) throw Error('An analysis supports up to 12 comparisons.');
                this.comparisons = [...this.comparisons.filter(s => s.id !== spec.id), spec]; this.commit(); this.buildComparison();
            } catch (e) { status.textContent = (e as Error).message; }
        };
    }
    private buildRelationship(saved?: RelationshipSpec) {
        this.relationshipForm.replaceChildren(); this.relationshipForm.className = 'comparison-editor';
        const name = input(saved?.name ?? 'Record relationship'), left = select(this.sourceOptions()), right = select(this.sourceOptions()); if (saved) { left.value = saved.leftSource; right.value = saved.rightSource; } else right.selectedIndex = Math.min(1, right.options.length - 1);
        const useId = input('', 'checkbox'), useTime = input('', 'checkbox'), useSpace = input('', 'checkbox'), leftId = el('select'), rightId = el('select'), leftTime = el('select'), rightTime = el('select'), tolerance = input(String((saved?.time?.toleranceMs ?? 60000) / 1000), 'number'), radius = input(String(saved?.spatial?.radiusMetres ?? 100), 'number'), match = select([['all', 'All matches (many-to-many)'], ['unique', 'Unique only (ambiguous excluded)'], ['nearest', 'Nearest (distance, then time; ties use lowest row)']]);
        useId.checked = saved ? !!saved.identifier : true; useTime.checked = !!saved?.time; useSpace.checked = !!saved?.spatial; match.value = saved?.match ?? 'all'; tolerance.min = radius.min = '0'; tolerance.step = radius.step = 'any';
        const controls = el('div'); controls.className = 'comparison-controls'; controls.append(field('Relationship name', name), field('Left source', left), field('Right source', right), field('Match rule', match));
        const rules = el('div'); rules.className = 'comparison-controls';
        rules.append(field('Match identifier exactly (same value and type)', useId), field('Left identifier', leftId), field('Right identifier', rightId), field('Match UTC time within tolerance', useTime), field('Left timestamp', leftTime), field('Right timestamp', rightTime), field('Time tolerance (seconds)', tolerance), field('Match geographic proximity', useSpace), field('Radius (metres, great-circle distance)', radius));
        const update = () => { this.populate(leftId, left.value, undefined, true); this.populate(rightId, right.value, undefined, true); this.populate(leftTime, left.value, ['date']); this.populate(rightTime, right.value, ['date']); };
        left.onchange = right.onchange = update; this.updateRelationshipFields = update; update(); if (saved?.identifier) { leftId.value = saved.identifier.left; rightId.value = saved.identifier.right; } if (saved?.time) { leftTime.value = saved.time.left; rightTime.value = saved.time.right; }
        const submit = el('button', saved ? 'Update relationship' : 'Save relationship and preview'); submit.type = 'submit'; const status = el('p'); status.setAttribute('role', 'status');
        this.relationshipForm.append(controls, rules, submit, status);
        this.relationshipForm.onsubmit = e => {
            e.preventDefault();
            try {
                if (left.value === right.value || !left.value || !right.value) throw Error('Choose two different enabled sources.');
                if (!useId.checked && !useTime.checked && !useSpace.checked) throw Error('Enable at least one matching rule.');
                const spec: RelationshipSpec = { id: saved?.id ?? createUUID(), name: name.value.trim(), leftSource: left.value, rightSource: right.value, match: match.value as RelationshipSpec['match'], ...(useId.checked ? { identifier: { left: leftId.value, right: rightId.value } } : {}), ...(useTime.checked ? { time: { left: leftTime.value, right: rightTime.value, toleranceMs: Number(tolerance.value) * 1000 } } : {}), ...(useSpace.checked ? { spatial: { radiusMetres: Number(radius.value) } } : {}) };
                if (!saved && this.relationships.length >= 12) throw Error('An analysis supports up to 12 relationships.');
                this.relationships = [...this.relationships.filter(s => s.id !== spec.id), spec]; this.commit(); this.buildRelationship();
            } catch (e) { status.textContent = (e as Error).message; }
        };
    }
    private commit() { this.changed(); this.mountCards(); this.refresh(); }
    private mountCards() {
        this.cards.clear(); this.rendered.clear(); this.comparisonList.replaceChildren(); this.relationshipList.replaceChildren();
        for (const spec of [...this.comparisons, ...this.relationships]) {
            const comparison = 'series' in spec, root = el('article'); root.className = 'comparison-card'; root.dataset.specId = spec.id;
            const status = el('p', 'Load mapped sources to calculate.'); status.setAttribute('role', 'status'); const output = el('div');
            root.append(el('h3', spec.name), button('Edit', () => comparison ? this.buildComparison(spec) : this.buildRelationship(spec)), button('Remove', () => { this.comparisons = this.comparisons.filter(s => s.id !== spec.id); this.relationships = this.relationships.filter(s => s.id !== spec.id); this.commit(); }), status, output);
            (comparison ? this.comparisonList : this.relationshipList).append(root); this.cards.set(spec.id, { root, status, output });
        }
    }
    sourcesChanged() { this.buildComparison(); this.buildRelationship(); this.refresh(); }
    refresh() {
        this.updateComparisonFields?.(); this.updateRelationshipFields?.();
        clearTimeout(this.timer); this.epoch++; this.token++; this.worker.postMessage({ type: 'reset' }); this.pending.clear(); this.rendered.clear();
        for (const card of this.cards.values()) { delete card.root.dataset.ready; card.output.replaceChildren(); card.status.textContent = 'Waiting for applied source results…'; }
        this.showRelated(); this.timer = setTimeout(() => this.calculate(), 100);
    }
    private calculate() {
        for (const spec of this.comparisons) {
            const key = `c:${spec.id}`, data = new Map<string, Projection>(); this.pending.set(key, { kind: 'compare', spec, data, needed: spec.series.length });
            if (spec.series.some(s => !this.source(s.sourceId)?.done || this.source(s.sourceId)?.filtering)) { this.cards.get(spec.id)!.status.textContent = 'Load and enable every mapped source; calculations use applied results.'; continue; }
            for (const series of spec.series) this.send(series.sourceId, { type: 'project', token: `${this.epoch}:${key}:${series.id}`, task: key, part: series.id, fields: [...new Set([series.x, ...(series.y ? [series.y] : [])])], filter: series.filter });
        }
        for (const spec of this.relationships) {
            const key = `r:${spec.id}`, data = new Map<string, Projection>(); this.pending.set(key, { kind: 'relate', spec, data, needed: 2 });
            if (![spec.leftSource, spec.rightSource].every(id => this.source(id)?.done && !this.source(id)?.filtering)) { this.cards.get(spec.id)!.status.textContent = 'Load and enable both sources to preview.'; continue; }
            for (const side of ['left', 'right'] as const) this.send(side === 'left' ? spec.leftSource : spec.rightSource, { type: 'project', token: `${this.epoch}:${key}:${side}`, task: key, part: side, fields: [...new Set([...(spec.identifier ? [spec.identifier[side]] : []), ...(spec.time ? [spec.time[side]] : [])])] });
        }
    }
    handle(sourceId: string, m: any) {
        if (!['projected', 'projectionError'].includes(m.type) || !String(m.token).startsWith(`${this.epoch}:`)) return;
        const pending = this.pending.get(m.task); if (!pending) return;
        if (m.type === 'projectionError') { this.cards.get(pending.spec.id)!.status.textContent = m.message; this.pending.delete(m.task); return; }
        m.data.sourceId = sourceId; pending.data.set(m.part, m.data);
        if (pending.data.size === pending.needed) {
            this.cards.get(pending.spec.id)!.status.textContent = 'Calculating applied results…';
            this.worker.postMessage({ type: pending.kind, spec: pending.spec, token: this.epoch, ...(pending.kind === 'compare' ? { data: [...pending.data] } : { left: pending.data.get('left'), right: pending.data.get('right') }) }); this.pending.delete(m.task);
        }
    }
    private result(m: any) {
        if (m.type === 'refs') { if (m.token === this.token) this.choose(m.refs); return; }
        if (m.token !== this.epoch) return;
        const card = this.cards.get(m.id); if (!card) return;
        if (m.type === 'error') { card.status.textContent = m.message; return; }
        if (m.type === 'compared') this.drawComparison(this.comparisons.find(s => s.id === m.id)!, card, m.result);
        if (m.type === 'related') this.drawRelationship(this.relationships.find(s => s.id === m.id)!, card, m.result);
        this.showRelated();
    }
    private pick(spec: ComparisonSpec, series: string, bin: number) { this.worker.postMessage({ type: 'pick', id: spec.id, series, bin, token: ++this.token }); }
    private drawComparison(spec: ComparisonSpec, card: Card, result: Omit<ComparisonResult, 'series'> & { series: Omit<ComparisonResult['series'][number], 'members'>[] }) {
        card.output.replaceChildren();
        const seriesColors = ['#0d9188', '#3984cf', '#8b69c7', '#d29032', '#c86579', '#4d9c50', '#476174', '#c47824'];
        card.status.textContent = `${result.edges.length - 1} common ${spec.kind === 'time' ? 'UTC buckets' : 'bins'} · ${spec.kind === 'time' ? spec.aggregate : 'count'} · unit ${spec.unit}`;
        const legend = el('div'); legend.className = 'comparison-legend';
        for (const [i, series] of result.series.entries()) { const mapping = spec.series[i]; const item = el('p', `${series.label} · ${this.source(series.sourceId)?.name ?? series.sourceId} · ${mapping.x}${mapping.y ? ' → ' + mapping.y : ''} · ${mapping.unit}${mapping.converted ? ` × ${mapping.scale} + ${mapping.offset} → ${spec.unit}` : ''} · ${series.counts.reduce((a,b)=>a+b,0)} plotted · ${series.missing} missing · additional filter ${JSON.stringify(mapping.filter)}`); item.style.borderLeft = `4px solid ${seriesColors[i]}`; legend.append(item); }
        const canvas = el('canvas'); canvas.className = 'comparison-canvas'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${spec.name}. Shared ${spec.kind === 'time' ? 'UTC time' : spec.unit} axis. Use the bin table below for keyboard inspection.`);
        const bins = result.edges.length - 1;
        const draw = () => {
            const width = canvas.clientWidth || 800, height = 290, d = Math.min(devicePixelRatio, 2); canvas.width = width * d; canvas.height = height * d;
            const ctx = canvas.getContext('2d')!; ctx.scale(d,d); const values = result.series.flatMap(s => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
            const low = values.reduce((v,x)=>Math.min(v,x),0), high = values.reduce((v,x)=>Math.max(v,x),1), left = 72, right = width - 22, top = 16, bottom = 235;
            ctx.strokeStyle = themeColor('chart-axis'); ctx.fillStyle = themeColor('text'); ctx.font = '12px system-ui';
            ctx.beginPath(); ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();
            for(let i=0;i<5;i++){const value=low+(high-low)*i/4,y=bottom-(bottom-top)*i/4;ctx.fillText(value.toLocaleString(undefined,{maximumFractionDigits:2}),5,y);ctx.strokeStyle=themeColor('chart-grid');ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();}
            ctx.textAlign='center'; const format=(v:number)=>spec.kind==='time'?formatUTC(v):v.toLocaleString(undefined,{maximumFractionDigits:3});
            ctx.fillText(format(result.edges[0]),left+60,260);ctx.fillText(format(result.edges.at(-1)!),right-70,260);ctx.fillText(spec.kind==='time'?'UTC time':spec.unit,(left+right)/2,282);
            for(const [si,series] of result.series.entries()){ctx.fillStyle=ctx.strokeStyle=seriesColors[si];ctx.lineWidth=2;let previous=false;ctx.beginPath();for(let k=0;k<bins;k++){const value=series.values[k];if(value===null){previous=false;continue;}const x=left+(k+.5)*(right-left)/bins,y=bottom-(value-low)/(high-low)*(bottom-top);if(spec.kind==='histogram'){const w=(right-left)/bins/result.series.length;ctx.fillRect(left+k*(right-left)/bins+si*w,y,Math.max(.5,w-1),Math.abs(bottom-y));}else{if(previous)ctx.lineTo(x,y);else ctx.moveTo(x,y);previous=true;}}if(spec.kind==='time')ctx.stroke();}
        };
        this.rendered.set(spec.id, draw); card.output.append(legend, canvas); requestAnimationFrame(draw);
        canvas.onclick = e => { const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,bin=Math.max(0,Math.min(bins-1,Math.floor((x-72)/(rect.width-94)*bins))); const sub=(x-72)/(rect.width-94)*bins-bin; const si=spec.kind==='histogram'?Math.min(result.series.length-1,Math.max(0,Math.floor(sub*result.series.length))):0; this.pick(spec,result.series[si].id,bin); };
        const table = el('table'), controls = el('div'); controls.className = 'row'; let start = 0;
        const previous=button('Previous bins',()=>{start=Math.max(0,start-40);render();}),next=button('Next bins',()=>{start+=40;render();});
        const render = () => { table.replaceChildren(); const head=el('tr');head.append(el('th',spec.kind==='time'?'UTC interval':'Value interval'));for(const series of result.series)head.append(el('th',series.label));table.append(head);for(let k=start;k<Math.min(bins,start+40);k++){const row=el('tr');row.append(el('th',`${spec.kind==='time'?formatUTC(result.edges[k]):result.edges[k].toPrecision(5)} ≤ x ${k===bins-1&&spec.kind==='histogram'?'≤':'<'} ${spec.kind==='time'?formatUTC(result.edges[k+1]):result.edges[k+1].toPrecision(5)}`));for(const series of result.series){const td=el('td');td.append(button(`${series.values[k]??'null'} · ${series.counts[k]} records`,()=>this.pick(spec,series.id,k)));row.append(td);}table.append(row);}previous.disabled=!start;next.disabled=start+40>=bins;};
        controls.append(previous,next);card.output.append(controls,table);render();
    }
    private drawRelationship(spec: RelationshipSpec, card: Card, result: Omit<RelationshipResult, 'pairs'>) {
        card.output.replaceChildren(); card.root.dataset.ready = 'true';
        card.status.textContent = `Left: ${result.matchedLeft}/${result.leftTotal} matched · ${result.unmatchedLeft} unmatched · ${result.multiplyLeft} multiply matched candidates. Right: ${result.matchedRight}/${result.rightTotal} matched · ${result.unmatchedRight} unmatched · ${result.multiplyRight} multiple incoming links.`;
        const rules = el('p', `${this.source(spec.leftSource)?.name} ↔ ${this.source(spec.rightSource)?.name} · ${spec.match} · AND rules: ${JSON.stringify({ identifier: spec.identifier, time: spec.time, spatial: spec.spatial })}`); const table = el('table');const head=el('tr');head.append(el('th','Left record'),el('th','Candidate matches'),el('th','Accepted links'));table.append(head);
        for(const row of result.preview){const tr=el('tr'),left=el('td'),count=el('td',String(row.candidates)),matched=el('td');left.append(button(`${row.id??'null'} · row ${row.left+1}`,()=>this.choose([{sourceId:spec.leftSource,index:row.left}])));matched.append(button(row.matched.length?`${row.matched.length} matches`:'Unmatched',()=>this.choose(row.matched.map(index=>({sourceId:spec.rightSource,index})))));tr.append(left,count,matched);table.append(tr);}card.output.append(rules,el('p','Preview of the first 50 left records. Totals cover every applied record. Nearest uses distance when spatial matching is enabled, otherwise time difference; ties use lowest source row.'),table);
    }
    private showRelated() {
        this.related.replaceChildren(); const selected=this.selected;if(!selected)return;
        this.related.append(el('p','Inspection propagation is manual: choose a saved relationship to inspect its accepted links. Filters stay unchanged.'));
        for(const spec of this.relationships)if([spec.leftSource,spec.rightSource].includes(selected.sourceId)&&this.cards.get(spec.id)?.root.dataset.ready==='true')this.related.append(button(`Inspect related records: ${spec.name}`,()=>this.worker.postMessage({type:'relatedRefs',spec,id:spec.id,ref:selected,token:++this.token})));
    }
}
