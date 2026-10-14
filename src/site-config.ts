export type SiteConfig = {
    bannerText: string;
    bannerBackground: string;
    defaultBasemapUrl: string;
    defaultBasemapAttribution: string;
};
export async function readSiteConfig(): Promise<SiteConfig> {
    const defaults: SiteConfig = { bannerText: '', bannerBackground: '#eaf0f4', defaultBasemapUrl: '', defaultBasemapAttribution: '' };
    try {
        const response = await fetch('/api/site-config', { cache: 'no-store' });
        if (!response.ok) return defaults;
        const value = await response.json();
        for (const key of Object.keys(defaults) as (keyof SiteConfig)[]) {
            if (typeof value?.[key] === 'string') defaults[key] = value[key];
        }
    } catch {
        // Standalone/local sessions remain usable without the configuration service.
    }
    return defaults;
}
