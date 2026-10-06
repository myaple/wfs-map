/** Multi-stop numeric ramps. Cividis and Viridis are colour-vision-friendly
 * scientific palettes; each preset is sampled at five evenly spaced stops. */
export const colourSchemes = [
    { id: 'viridis', name: 'Viridis · colour-blind friendly', colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
    { id: 'cividis', name: 'Cividis · colour-blind friendly', colors: ['#00224e', '#434e6c', '#7d7c78', '#bcae6c', '#fee838'] },
    { id: 'inferno', name: 'Inferno · heat', colors: ['#000004', '#57106e', '#bc3754', '#f98e09', '#fcffa4'] },
    { id: 'ocean', name: 'Ocean · sequential', colors: ['#081d58', '#225ea8', '#41b6c4', '#a1dab4', '#ffffd9'] },
    { id: 'blue-red', name: 'Blue–White–Red · diverging', colors: ['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b'] }
] as const;
export type ColourScheme = typeof colourSchemes[number]['id'];
export const defaultColourScheme: ColourScheme = 'viridis';
export function colourStops(scheme?: string): readonly string[] {
    return (colourSchemes.find(s => s.id === scheme) ?? colourSchemes[0]).colors;
}
export function numericPalette(stops: readonly string[], bins: number): Float32Array {
    const palette = new Float32Array(64 * 3);
    const rgb = stops.map(s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255));
    for (let i = 0; i < 64; i++) {
        const position = Math.min(1, i / Math.max(1, bins - 1)) * (rgb.length - 1);
        const segment = Math.min(rgb.length - 2, Math.floor(position)), fraction = position - segment;
        for (let c = 0; c < 3; c++) palette[i * 3 + c] = rgb[segment][c] + (rgb[segment + 1][c] - rgb[segment][c]) * fraction;
    }
    return palette;
}
