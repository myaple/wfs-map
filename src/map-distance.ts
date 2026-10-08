export type MapLocation = [longitude: number, latitude: number];

/** Shortest surface distance on the mean-radius Earth, independent of map zoom. */
export function mapDistance(a: MapLocation, b: MapLocation) {
    const radians = Math.PI / 180;
    const latitude = Math.sin((b[1] - a[1]) * radians / 2);
    const longitude = Math.sin((b[0] - a[0]) * radians / 2);
    const haversine = latitude ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * longitude ** 2;
    const meters = 2 * 6371008.8 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
    return { feet: meters / 0.3048, meters, nauticalMiles: meters / 1852 };
}
