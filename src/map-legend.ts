import type { Field } from './data.ts';
import type { SavedSource } from './source-settings.ts';
import type { PointsLayer } from './points-layer.ts';
import { categoryColors } from './category-colors.ts';
import { colourStops } from './colour-schemes.ts';

type LegendSource = Pick<SavedSource, 'id' | 'name' | 'enabled'> & {
    color: [number, number, number]; coloring: NonNullable<SavedSource['coloring']>;
    fields: Field[]; done: boolean; colorLegend: string; mapVisible: boolean;
    colorCategories?: string[]; colorLabels?: string[];
    layer: Pick<PointsLayer, 'palette'>;
};
type Group = { source: LegendSource; start: number; count: number; palette?: Map<string, string> };
const rowHeight = 44;
const rgb = (values: ArrayLike<number>) => `rgb(${Array.from(values, v => Math.round(v * 255)).join(', ')})`;

/** Only visible legend rows enter the DOM, even for large categorical domains. */
class LegendValues {
    private viewport = document.createElement('div');
    private space = document.createElement('div');
    private rows = document.createElement('div');
    private groups: Group[] = [];
    private signature: unknown[] = [];
    private total = 0;
    private extent = 0;
    private observer: ResizeObserver;
    constructor(private root: HTMLElement) {
        this.viewport.className = 'map-legend-viewport'; this.viewport.tabIndex = 0;
        this.viewport.setAttribute('role', 'list'); this.viewport.setAttribute('aria-label', 'Point colours for enabled data sources');
        this.space.className = 'map-legend-space'; this.rows.className = 'map-legend-rows';
        this.space.append(this.rows); this.viewport.append(this.space); root.append(this.viewport);
        this.viewport.addEventListener('scroll', () => this.render());
        this.observer = new ResizeObserver(() => this.render());
        this.observer.observe(this.viewport);
    }
    destroy() { this.observer.disconnect(); }
    update(sources: LegendSource[]) {
        const enabled = sources.filter(s => s.enabled);
        const signature = enabled.flatMap(s => [s.id, s.name, s.done, s.color, s.coloring, s.colorCategories, s.colorLabels, s.colorLegend]);
        if (signature.length === this.signature.length && signature.every((value, i) => value === this.signature[i])) return;
        this.signature = signature; this.total = 0;
        this.groups = enabled.map(source => {
            const count = !source.coloring.field || !source.done ? 1 : source.colorCategories ? source.colorCategories.length + 1 : source.colorLabels ? source.colorLabels.length + 1 : 1;
            const group = { source, start: this.total, count, palette: source.colorCategories ? categoryColors(source.colorCategories, source.coloring.categories?.[source.coloring.field]) : undefined };
            this.total += count; return group;
        });
        // Stay below browser layout-size limits for million-value domains.
        this.extent = Math.min(this.total * rowHeight, 10_000_000);
        this.space.style.height = `${this.extent}px`;
        this.viewport.scrollTop = Math.min(this.viewport.scrollTop, Math.max(0, this.extent - this.viewport.clientHeight));
        this.root.hidden = !enabled.length;
        this.render();
    }
    private render() {
        const visible = Math.max(1, Math.ceil(this.viewport.clientHeight / rowHeight));
        const scaled = this.extent < this.total * rowHeight;
        const first = scaled ? Math.floor(this.viewport.scrollTop / Math.max(1, this.extent - this.viewport.clientHeight) * Math.max(0, this.total - visible)) : Math.floor(this.viewport.scrollTop / rowHeight);
        const start = Math.max(0, first - 2), end = Math.min(this.total, first + visible + 2);
        const top = scaled ? this.viewport.scrollTop - (first - start) * rowHeight : start * rowHeight;
        this.rows.style.top = `${Math.max(0, Math.min(top, this.extent - (end - start) * rowHeight))}px`;
        this.rows.replaceChildren();
        for (let index = start; index < end; index++) {
            const group = this.groups.find(g => index >= g.start && index < g.start + g.count)!;
            const s = group.source, offset = index - group.start, field = s.coloring.field;
            let label: string, color: string | undefined;
            if (!field) { label = 'All points'; color = rgb(s.color); }
            else if (!s.done) label = 'Load source to show attribute colours';
            else if (s.colorCategories) {
                label = offset < s.colorCategories.length ? s.colorCategories[offset] || '(empty string)' : 'Missing value';
                color = offset < s.colorCategories.length ? group.palette!.get(s.colorCategories[offset]) : '#808080';
            } else if (s.colorLabels) {
                label = offset < s.colorLabels.length ? s.colorLabels[offset] : s.coloring.scale === 'log10' ? 'Missing / non-positive value' : 'Missing value';
                color = offset < s.colorLabels.length ? rgb(s.layer.palette.subarray(offset * 3, offset * 3 + 3)) : '#808080';
            } else label = s.colorLegend || 'Updating colours…';
            const row = document.createElement('div'); row.className = 'map-legend-row'; row.dataset.source = s.id;
            row.setAttribute('role', 'listitem'); row.setAttribute('aria-setsize', String(this.total)); row.setAttribute('aria-posinset', String(index + 1));
            const swatch = document.createElement('span'); swatch.className = 'map-legend-swatch'; swatch.setAttribute('aria-hidden', 'true');
            if (color) swatch.style.backgroundColor = color; else swatch.hidden = true;
            const text = document.createElement('div'), value = document.createElement('span'), owner = document.createElement('small');
            value.textContent = label; owner.textContent = `${s.name}${field ? ' · ' + field : ''}`;
            row.title = `${owner.textContent}: ${label}`;
            text.append(value, owner); row.append(swatch, text); this.rows.append(row);
        }
    }
}


type Entry = {
    root: HTMLElement; details: HTMLDetailsElement; summary: HTMLElement;
    preview: HTMLElement; name: HTMLElement; mode: HTMLElement; toggle: HTMLInputElement;
    values: LegendValues; source: LegendSource;
};

/** One stable entry per dataset; large colour domains are rendered only when opened. */
export class MapLegend {
    private entries = new Map<string, Entry>();
    private list = document.createElement('div');
    constructor(private root: HTMLElement, private visibility: (id: string, visible: boolean) => void) {
        const title = document.createElement('h2'); title.textContent = 'Map legend';
        this.list.className = 'map-legend-sources';
        this.list.setAttribute('role', 'list');
        this.list.setAttribute('aria-label', 'Data source colours and map visibility');
        root.append(title, this.list);
    }
    update(sources: LegendSource[]) {
        const enabled = sources.filter(s => s.enabled);
        for (const [id, entry] of this.entries) if (!enabled.some(s => s.id === id)) {
            entry.values.destroy(); entry.root.remove(); this.entries.delete(id);
        }
        for (const source of enabled) {
            let entry = this.entries.get(source.id);
            if (!entry) {
                const container = document.createElement('div'); container.className = 'map-legend-source';
                container.dataset.source = source.id; container.setAttribute('role', 'listitem');
                const details = document.createElement('details'), summary = document.createElement('summary');
                details.className = 'map-legend-details'; summary.className = 'map-legend-summary';
                const preview = document.createElement('span'); preview.className = 'map-legend-preview'; preview.setAttribute('aria-hidden', 'true');
                const text = document.createElement('span'), name = document.createElement('span'), mode = document.createElement('small');
                text.className = 'map-legend-description'; name.className = 'map-legend-name';
                text.append(name, mode); summary.append(preview, text); details.append(summary);
                const body = document.createElement('div'); details.append(body);
                const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'map-legend-toggle'; toggle.setAttribute('role', 'switch');
                container.append(details, toggle); this.list.append(container);
                entry = { root: container, details, summary, preview, name, mode, toggle, values: new LegendValues(body), source };
                const current = entry;
                details.addEventListener('toggle', () => { if (details.open) current.values.update([current.source]); });
                toggle.addEventListener('change', () => this.visibility(current.source.id, toggle.checked));
                this.entries.set(source.id, entry);
            }
            entry.source = source; entry.name.textContent = source.name;
            const field = source.coloring.field;
            entry.mode.textContent = !field ? 'Single colour' : `${field} · ${source.colorCategories ? 'Categories' : source.coloring.scale === 'log10' ? 'Log10 gradient' : 'Linear gradient'}`;
            entry.summary.title = `${source.name} · click for colour values`;
            entry.toggle.checked = source.mapVisible;
            entry.toggle.setAttribute('aria-label', `Show ${source.name} on map`);
            entry.toggle.title = 'Show or hide this dataset on the map only';
            entry.root.classList.toggle('map-legend-hidden', !source.mapVisible);
            // Use a bounded sample for a categorical overview, without building the full palette.
            let background: string;
            if (!field || !source.done) background = rgb(source.color);
            else if (source.colorCategories?.length) {
                const sample = source.colorCategories.slice(0, 8);
                const colours = Array.from(categoryColors(sample, source.coloring.categories?.[field]).values());
                background = `linear-gradient(to right, ${colours.flatMap((c, i) => [`${c} ${i / colours.length * 100}%`, `${c} ${(i + 1) / colours.length * 100}%`]).join(', ')})`;
            } else if (source.colorLabels?.length) background = `linear-gradient(to right, ${colourStops(source.coloring.scheme).join(', ')})`;
            else background = '#808080';
            entry.preview.style.background = background;
            if (entry.details.open) entry.values.update([source]);
        }
        this.root.hidden = !enabled.length;
    }
}
