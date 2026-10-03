// Defaults depend only on the sorted full-data domain, never row order or filters.
const palette = ['#4477aa', '#ee6677', '#228833', '#ccbb44', '#66ccee', '#aa3377', '#882255', '#332288', '#ee7733', '#009988'];
export function categoryColors(values: string[], overrides: Record<string, string> = {}) {
    const result = new Map<string, string>(), used = new Set<number>();
    [...values].sort().forEach((value, index) => {
        let color: string;
        if (index < palette.length) color = palette[index];
        else {
            const hue = (index * .618033988749895 % 1) * 6;
            const chroma = .55 + (index % 3) * .08, base = .1 + (index % 4) * .035;
            const x = chroma * (1 - Math.abs(hue % 2 - 1));
            const rgb = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue)];
            color = '#' + rgb.map(v => Math.round((v + base) * 255).toString(16).padStart(2, '0')).join('');
        }
        let code = parseInt(color.slice(1), 16);
        while (used.size < 0x1000000 && used.has(code)) code = (code + 1) % 0x1000000;
        used.add(code);
        const saved = Object.hasOwn(overrides, value) ? overrides[value] : undefined;
        result.set(value, saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved : '#' + code.toString(16).padStart(6, '0'));
    });
    return result;
}
export function colorBytes(hex: string) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
