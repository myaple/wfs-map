import type { Field } from './data.ts';
import type { SavedSource } from './source-settings.ts';

type ColorSource = Pick<SavedSource, 'id' | 'name' | 'enabled'> & {
    fields: Field[]; done: boolean; color: [number, number, number];
    coloring: NonNullable<SavedSource['coloring']>; colorLegend: string;
};
const input = <T extends HTMLInputElement | HTMLSelectElement>(id: string) => document.getElementById(id) as T;

// Colour selection has its own source context, independent of filters/charts.
export class PointColors {
    private source = input<HTMLSelectElement>('colorSource');
    constructor(private sources: () => ColorSource[], private changed: (source: ColorSource, previous: ColorSource['coloring']) => void) {
        this.source.onchange = () => this.update();
        for (const id of ['colorAttribute', 'colorBins', 'colorLow', 'colorHigh', 'sourceColor']) {
            input(id).onchange = () => {
                const s = this.current();
                if (!s) return;
                const previous = s.coloring;
                s.coloring = { field: input('colorAttribute').value, bins: Number(input('colorBins').value), low: input('colorLow').value, high: input('colorHigh').value };
                if (id === 'sourceColor') {
                    const hex = input('sourceColor').value;
                    s.color = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
                }
                this.changed(s, previous);
                this.update();
            };
        }
    }
    private current() { return this.sources().find(s => s.id === this.source.value); }
    refresh() {
        const id = this.source.value;
        this.source.replaceChildren(...this.sources().map(s => new Option(s.name + (s.enabled ? '' : ' (disabled)'), s.id)));
        if (this.sources().some(s => s.id === id)) this.source.value = id;
        if (!this.sources().length) this.source.add(new Option('No data sources', ''));
        this.source.disabled = !this.sources().length;
        this.update();
    }
    update() {
        const s = this.current(), attribute = input<HTMLSelectElement>('colorAttribute');
        attribute.replaceChildren(new Option('Single source colour', ''), ...(s?.fields ?? []).map(f => new Option(f.name, f.name)));
        attribute.value = s?.coloring.field ?? '';
        input('colorBins').value = String(s?.coloring.bins ?? 24);
        input('colorLow').value = s?.coloring.low ?? '#2463d4';
        input('colorHigh').value = s?.coloring.high ?? '#ee5539';
        input('sourceColor').value = '#' + (s?.color ?? [0.02, 0.45, 0.68]).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        const ramp = document.getElementById('colorRamp')!;
        ramp.hidden = !s?.coloring.field;
        if (s) ramp.style.background = `linear-gradient(to right,${s.coloring.low},${s.coloring.high})`;
        document.getElementById('colorLegend')!.textContent = s ? `${s.name} · ${!s.enabled ? 'Source disabled' : !s.done ? 'Attributes available after loading' : s.colorLegend || 'Single colour for every point'}` : 'Add a data source to configure point colours.';
        attribute.disabled = !s?.enabled || !s.done;
        input('sourceColor').disabled = !s || !!s.coloring.field;
        for (const id of ['colorBins', 'colorLow', 'colorHigh']) input(id).disabled = !s?.enabled || !s.done || !s.coloring.field;
    }
}
