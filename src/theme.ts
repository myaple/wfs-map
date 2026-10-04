type Theme = 'light' | 'dark';
const key = 'wfs-theme';
let preference: Theme | undefined;
let system: MediaQueryList;

function readPreference(): Theme | undefined {
    try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : undefined; }
    catch { return undefined; }
}
function apply(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach(button => button.setAttribute('aria-pressed', String(theme === 'dark')));
    window.dispatchEvent(new Event('themechange'));
}
export function initializeTheme() {
    preference = readPreference();
    system = matchMedia('(prefers-color-scheme: dark)');
    apply(preference ?? (system.matches ? 'dark' : 'light'));
    system.addEventListener('change', () => { if (!preference) apply(system.matches ? 'dark' : 'light'); });
    window.addEventListener('storage', event => {
        if (event.key === key || event.key === null) {
            preference = readPreference();
            apply(preference ?? (system.matches ? 'dark' : 'light'));
        }
    });
}
export function mountThemeToggle(header: Element) {
    const button = document.createElement('button');
    button.className = 'theme-toggle'; button.type = 'button'; button.textContent = 'Dark mode';
    button.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
    button.onclick = () => {
        preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, preference); } catch { /* Still works for this session. */ }
        apply(preference);
    };
    header.append(button);
}
/** Canvas and MapLibre paint cannot inherit CSS; read the same theme tokens. */
export function themeColor(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}
