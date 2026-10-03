import { Popup, type Map, type LngLatLike, type Offset } from 'maplibre-gl';

const anchors = {
    center: [.5, .5], top: [.5, 0], bottom: [.5, 1], left: [0, .5], right: [1, .5],
    'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1]
} as const;

/** Keep the inspector inside both the map and the visible browser viewport. */
export function metadataPopup(map: Map, coordinates: LngLatLike, content: HTMLElement): Popup {
    const popup = new Popup({ className: 'metadata-popup', maxWidth: '380px' })
        .setLngLat(coordinates).setDOMContent(content).addTo(map);
    const update = () => {
        const bounds = map.getContainer().getBoundingClientRect(), margin = 8;
        if (!bounds.width || !bounds.height) return;
        let left = Math.max(0, -bounds.left) + margin;
        let top = Math.max(0, -bounds.top) + margin;
        let right = Math.min(bounds.width, innerWidth - bounds.left) - margin;
        let bottom = Math.min(bounds.height, innerHeight - bounds.top) - margin;
        // Keep an offscreen map's popup within the map until it scrolls into view.
        if (right <= left || bottom <= top) {
            left = top = margin;
            right = bounds.width - margin;
            bottom = bounds.height - margin;
        }
        popup.setMaxWidth(`${Math.min(380, right - left)}px`);
        const element = popup.getElement();
        element.style.setProperty('--metadata-height', `${Math.min(460, bottom - top)}px`);
        const width = element.offsetWidth, height = element.offsetHeight;
        const point = map.project(popup.getLngLat());
        const offsets = {} as Record<keyof typeof anchors, [number, number]>;
        // MapLibre chooses an anchor, but cannot fit a tall popup on either side
        // of a central point. Supply a bounded offset for every possible anchor.
        for (const [anchor, [x, y]] of Object.entries(anchors)) {
            const px = point.x - x * width, py = point.y - y * height;
            offsets[anchor as keyof typeof anchors] = [
                Math.max(left, Math.min(px, right - width)) - px,
                Math.max(top, Math.min(py, bottom - height)) - py
            ];
        }
        popup.setOffset(offsets as Offset);
        // A shifted arrow would point at the wrong location. Keep its space so
        // hiding it does not change the dimensions used above.
        const shifted = Object.entries(offsets).some(([anchor, offset]) =>
            element.classList.contains(`maplibregl-popup-anchor-${anchor}`) && offset.some(n => Math.abs(n) > .5));
        element.classList.toggle('is-clamped', shifted);
    };
    map.on('move', update);
    map.on('resize', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    popup.on('close', () => {
        map.off('move', update);
        map.off('resize', update);
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
    });
    update();
    return popup;
}
