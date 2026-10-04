/** Deployment-wide text, kept outside #app so page rendering cannot remove it. */
export async function mountPageBanners() {
    try {
        const response = await fetch('/api/site-config', { cache: 'no-store' });
        if (!response.ok) return;
        const config = await response.json();
        if (typeof config.bannerText !== 'string' || !config.bannerText.trim()) return;
        const text = config.bannerText.replace(/[\r\n\u2028\u2029]+/g, ' ');
        const background = typeof config.bannerBackground === 'string' && CSS.supports('color', config.bannerBackground)
            ? config.bannerBackground : '#eaf0f4';
        for (const id of ['page-header', 'page-footer']) {
            const banner = document.getElementById(id)!;
            banner.textContent = text;
            banner.style.backgroundColor = background;
            banner.hidden = false;
        }
        document.body.classList.add('has-page-banners');
    } catch {
        // Keep local analyses usable when the configuration service is unavailable.
    }
}
