/** ISO dates are UTC unless an explicit numeric timezone offset is supplied.
 * Never let Date.parse interpret an unzoned value in the workstation timezone.
 */
export function parseUTC(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
    if (!match) return NaN;
    const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
    const local = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}Z`;
    const stamp = Date.parse(local), date = new Date(stamp);
    if (!Number.isFinite(stamp) || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
    if (zone.toUpperCase() === 'Z') return stamp;
    const digits = zone.slice(1).replace(':', ''), hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
    return stamp - (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000;
}

export function utcISO(value: string): string {
    const stamp = parseUTC(value);
    if (!Number.isFinite(stamp)) throw Error('Enter a valid ISO 8601 UTC date/time (YYYY-MM-DD HH:mm:ss).');
    return new Date(stamp).toISOString();
}

/** Deterministic 24-hour display, independent of browser locale and timezone. */
export function formatUTC(value: string | number): string {
    const stamp = typeof value === 'number' ? value : parseUTC(value);
    return Number.isFinite(stamp) ? new Date(stamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC') : 'Invalid UTC time';
}

export function utcInput(value: string): string { return utcISO(value).slice(0, -1).replace('T', ' '); }
