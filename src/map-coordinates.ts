import type { IControl, Map, MapMouseEvent, Point } from 'maplibre-gl';

export class MapCoordinates implements IControl {
    private map?: Map;
    private cursor?: Point;
    private output = document.createElement('div');
    private update = () => {
        const location = this.cursor && this.map?.unproject(this.cursor).wrap();
        this.output.textContent = location
            ? `Lat ${location.lat.toFixed(5)}°  Lon ${location.lng.toFixed(5)}°`
            : 'Lat —  Lon —';
    };
    private move = (event: MapMouseEvent) => { this.cursor = event.point; this.update(); };
    private leave = () => { this.cursor = undefined; this.update(); };
    onAdd(map: Map) {
        this.map = map;
        this.output.className = 'maplibregl-ctrl map-coordinates';
        this.output.setAttribute('aria-label', 'Cursor latitude and longitude');
        map.on('mousemove', this.move);
        // Keep the location current when the camera moves beneath a stationary cursor.
        map.on('move', this.update);
        map.getCanvas().addEventListener('mouseleave', this.leave);
        this.update();
        return this.output;
    }
    onRemove() {
        this.map?.off('mousemove', this.move);
        this.map?.off('move', this.update);
        this.map?.getCanvas().removeEventListener('mouseleave', this.leave);
        this.output.remove();
        this.map = undefined;
        this.cursor = undefined;
    }
}
