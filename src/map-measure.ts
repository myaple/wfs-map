import type { Map, MapMouseEvent } from 'maplibre-gl';
import { mapDistance, type MapLocation } from './map-distance.ts';

/** A map-local overlay keeps measurement independent of datasets and filters. */
export class MapMeasure {
    active = false;
    private start?: MapLocation;
    private end?: MapLocation;
    private preview?: MapLocation;
    private root = document.createElement('div');
    private help: HTMLElement;
    private dialog: HTMLElement;
    private close: HTMLButtonElement;
    private line: SVGPathElement;
    private endpoints: SVGCircleElement[];

    constructor(private map: Map, private button: HTMLButtonElement) {
        this.root.className = 'map-measure';
        this.root.hidden = true;
        this.root.innerHTML = `<svg class="map-measure-line" aria-hidden="true"><path/><circle r="4"/><circle r="4"/></svg>
            <div class="map-measure-help" role="status">Click the first point</div>
            <section class="map-measure-dialog" role="dialog" aria-label="Measured distance" hidden>
                <div class="map-measure-heading"><strong>Distance</strong><button type="button" aria-label="Close measurement" title="Close measurement">×</button></div>
                <dl><dt>Feet</dt><dd data-unit="feet"></dd><dt>Meters</dt><dd data-unit="meters"></dd><dt>Nautical miles</dt><dd data-unit="nauticalMiles"></dd></dl>
            </section>`;
        this.help = this.root.querySelector('.map-measure-help')!;
        this.dialog = this.root.querySelector('.map-measure-dialog')!;
        this.close = this.dialog.querySelector('button')!;
        this.line = this.root.querySelector('path')!;
        this.endpoints = [...this.root.querySelectorAll('circle')];
        this.close.onclick = () => { this.clear(); this.button.focus(); };
        map.getContainer().append(this.root);
        map.on('click', this.click);
        map.on('mousemove', this.move);
        map.on('move', this.render);
        map.on('resize', this.render);
        map.on('remove', this.destroy);
    }

    get picking() { return this.active && !this.end; }

    toggle() {
        if (this.active) { this.clear(); return; }
        this.active = true;
        this.root.hidden = false;
        this.help.hidden = false;
        this.help.textContent = 'Click the first point';
        this.button.setAttribute('aria-pressed', 'true');
        this.button.title = 'Clear measurement';
        this.map.getCanvas().classList.add('is-measuring');
        this.render();
    }

    clear() {
        this.active = false;
        this.start = this.end = this.preview = undefined;
        this.root.hidden = this.dialog.hidden = true;
        this.line.removeAttribute('d');
        this.endpoints.forEach(endpoint => { endpoint.style.display = 'none'; });
        this.button.setAttribute('aria-pressed', 'false');
        this.button.title = 'Measure distance';
        this.map.getCanvas().classList.remove('is-measuring');
    }

    private click = (event: MapMouseEvent) => {
        if (!this.picking || event.originalEvent.button !== 0) return;
        const location: MapLocation = [event.lngLat.lng, event.lngLat.lat];
        if (!this.start) {
            this.start = location;
            this.help.textContent = 'Click the second point';
        } else {
            this.end = location;
            const distances = mapDistance(this.start, this.end);
            const format = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
            for (const [unit, value] of Object.entries(distances)) this.dialog.querySelector(`[data-unit="${unit}"]`)!.textContent = format.format(value);
            this.help.hidden = true;
            this.dialog.hidden = false;
            this.map.getCanvas().classList.remove('is-measuring');
            this.close.focus({ preventScroll: true });
        }
        this.render();
    };

    private move = (event: MapMouseEvent) => {
        if (!this.picking || !this.start) return;
        this.preview = [event.lngLat.lng, event.lngLat.lat];
        this.render();
    };

    private render = () => {
        if (!this.active) return;
        const end = this.end ?? this.preview;
        const a = this.start && this.map.project(this.start);
        const b = end && this.map.project(end);
        this.line.setAttribute('d', a && b ? `M ${a.x} ${a.y} L ${b.x} ${b.y}` : '');
        [a, b].forEach((point, i) => {
            this.endpoints[i].style.display = point ? '' : 'none';
            if (point) { this.endpoints[i].setAttribute('cx', String(point.x)); this.endpoints[i].setAttribute('cy', String(point.y)); }
        });
    };

    private destroy = () => {
        this.clear();
        this.map.off('click', this.click);
        this.map.off('mousemove', this.move);
        this.map.off('move', this.render);
        this.map.off('resize', this.render);
        this.map.off('remove', this.destroy);
        this.root.remove();
    };
}
