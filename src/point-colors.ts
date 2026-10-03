import type { Field } from './data.ts';
import type { SavedSource } from './source-settings.ts';
import { categoryColors } from './category-colors.ts';

type ColorSource = Pick<SavedSource, 'id' | 'name' | 'enabled'> & {
    fields: Field[]; done: boolean; color: [number, number, number];
    coloring: NonNullable<SavedSource['coloring']>; colorLegend: string; colorCategories?: string[];
};
const input = <T extends HTMLInputElement | HTMLSelectElement>(id: string) => document.getElementById(id) as T;

// Colour selection has its own source context, independent of filters/charts.
export class PointColors {
    private source = input<HTMLSelectElement>('colorSource');
    private search = input<HTMLInputElement>('categorySearch');
    private limit = 50;
    private renderedSource?: ColorSource;
    private renderedField?: string;
    private renderedCategories?: string[];
    private renderedOverrides?: Record<string, string>;
    constructor(private sources: () => ColorSource[], private changed: (source: ColorSource, previous: ColorSource['coloring']) => void) {
        this.source.onchange = () => { this.search.value = ''; this.limit = 50; this.update(); };
        this.search.oninput = () => { this.limit = 50; this.renderCategories(); };
        document.getElementById('moreCategoryColors')!.onclick = () => { this.limit += 50; this.renderCategories(); };
        for (const id of ['colorAttribute', 'colorBins', 'colorLow', 'colorHigh', 'sourceColor']) {
            input(id).onchange = () => {
                const s = this.current();
                if (!s) return;
                const previous = s.coloring;
                s.coloring = { ...previous, field: input('colorAttribute').value, bins: Number(input('colorBins').value), low: input('colorLow').value, high: input('colorHigh').value };
                if (id === 'sourceColor') {
                    const hex = input('sourceColor').value;
                    s.color = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
                }
                if (id === 'colorAttribute') { this.search.value = ''; this.limit = 50; }
                this.changed(s, previous);
                this.update();
            };
        }
    }
    private current() { return this.sources().find(s => s.enabled && s.id === this.source.value); }
    refresh() {
        const id = this.source.value, sources = this.sources().filter(s => s.enabled);
        this.source.replaceChildren(...sources.map(s => new Option(s.name, s.id)));
        if (sources.some(s => s.id === id)) this.source.value = id;
        if (!sources.length) this.source.add(new Option('No enabled data sources', ''));
        this.source.disabled = !sources.length;
        if (id !== this.source.value) { this.search.value = ''; this.limit = 50; }
        this.update();
    }
    update() {
        const s = this.current(), attribute = input<HTMLSelectElement>('colorAttribute');
        attribute.replaceChildren(new Option('Single source colour', ''));
        for (const [kind, title] of [['string', 'Discrete colours · text fields'], ['number', 'Gradient · numeric fields']] as const) {
            const fields = s?.fields.filter(f => f.kind === kind) ?? [];
            if (!fields.length) continue;
            const group = document.createElement('optgroup'); group.label = title;
            group.append(...fields.map(f => new Option(f.name, f.name))); attribute.append(group);
        }
        attribute.value = s?.coloring.field ?? '';
        const kind = s?.fields.find(f => f.name === s.coloring.field)?.kind;
        const gradient = kind === 'number', categorical = kind === 'string';
        input('colorBins').value = String(s?.coloring.bins ?? 24);
        input('colorLow').value = s?.coloring.low ?? '#2463d4';
        input('colorHigh').value = s?.coloring.high ?? '#ee5539';
        input('sourceColor').value = '#' + (s?.color ?? [0.02, 0.45, 0.68]).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        document.getElementById('solidColorControl')!.hidden = !!s?.coloring.field;
        document.querySelectorAll<HTMLElement>('[data-gradient-control]').forEach(control => control.hidden = !gradient);
        document.getElementById('categoryColors')!.hidden = !categorical;
        const ramp = document.getElementById('colorRamp')!;
        ramp.hidden = !gradient;
        if (s) ramp.style.background = `linear-gradient(to right,${s.coloring.low},${s.coloring.high})`;
        document.getElementById('colorLegend')!.textContent = s ? `${s.name} · ${!s.done ? 'Attributes available after loading' : s.colorLegend || 'Single colour for every point'}` : 'Add or enable a data source to configure point colours.';
        attribute.disabled = !s?.enabled || !s.done;
        input('sourceColor').disabled = !s || !!s.coloring.field;
        for (const id of ['colorBins', 'colorLow', 'colorHigh']) input(id).disabled = !s?.enabled || !s.done || !gradient;
        if (this.renderedSource !== s || this.renderedField !== s?.coloring.field || this.renderedCategories !== s?.colorCategories || this.renderedOverrides !== s?.coloring.categories?.[s.coloring.field]) this.renderCategories();
    }
    private renderCategories() {
        const s = this.current(), field = s?.coloring.field ?? '';
        const overrides = s?.coloring.categories?.[field];
        this.renderedSource = s; this.renderedField = field; this.renderedCategories = s?.colorCategories; this.renderedOverrides = overrides;
        const search = this.search.value.toLocaleLowerCase();
        const palette = categoryColors(s?.colorCategories ?? [], overrides);
        const matches = (s?.colorCategories ?? []).filter(value => value.toLocaleLowerCase().includes(search));
        const list = document.getElementById('categoryColorList')!;
        list.replaceChildren();
        for (const value of matches.slice(0, this.limit)) {
            const row = document.createElement('label'); row.className = 'category-color-row';
            const label = document.createElement('span'); label.textContent = value || '(empty string)'; label.title = value;
            const picker = document.createElement('input'); picker.type = 'color'; picker.value = palette.get(value)!;
            picker.setAttribute('aria-label', `Colour for ${value || '(empty string)'}`); picker.disabled = !s?.enabled || !s.done;
            picker.onchange = () => {
                if (!s) return;
                const previous = s.coloring;
                s.coloring = { ...previous, categories: { ...previous.categories, [field]: { ...previous.categories?.[field], [value]: picker.value } } };
                this.changed(s, previous); this.update();
            };
            row.append(label, picker); list.append(row);
        }
        document.getElementById('moreCategoryColors')!.hidden = matches.length <= this.limit;
        document.getElementById('categoryColorCount')!.textContent = `${Math.min(matches.length, this.limit).toLocaleString()} of ${matches.length.toLocaleString()} values${search ? ' matching search' : ''} · every unique value has a colour`;
    }
}
