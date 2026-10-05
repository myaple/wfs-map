type Page = 'analysis' | 'records' | 'configuration' | 'derived';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
export function mountPageNavigation(nav: HTMLElement) {
    nav.className = 'page-navigation'; nav.setAttribute('aria-label', 'Workspace pages');
    const groups: { root: HTMLElement; button: HTMLButtonElement; menu: HTMLElement; pages: Page[] }[] = [];
    const close = () => { for (const g of groups) { g.menu.hidden = true; g.button.setAttribute('aria-expanded', 'false'); } };
    for (const [id, title, choices] of [
        ['analysisMenu', 'Analysis', [['analysis', 'Dashboard', 'analysisLink'], ['records', 'Records', 'recordsLink']]],
        ['dataSourcesMenu', 'Data sources', [['configuration', 'Configuration', 'configLink'], ['derived', 'Derived datasets', 'derivedLink']]],
    ] as const) {
        const root = el('div'), button = el('button', title), menu = el('div'); root.className = 'page-menu'; button.id = id;
        button.type = 'button'; button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id + 'Pages');
        menu.id = id + 'Pages'; menu.className = 'page-submenu'; menu.hidden = true;
        for (const [page, label, linkId] of choices) {
            const link = el('a', label); link.id = linkId; link.href = '#' + page;
            link.onclick = event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); location.hash = link.hash; close(); };
            menu.append(link);
        }
        const open = () => { close(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); };
        // Hover for mouse users; click and keyboard access also work on touch.
        root.onpointerenter = event => { if (event.pointerType === 'mouse') open(); };
        root.onpointerleave = event => { if (event.pointerType === 'mouse' && !root.contains(document.activeElement)) close(); };
        root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget as Node)) close(); });
        button.onclick = open;
        root.onkeydown = event => {
            const links = [...menu.querySelectorAll<HTMLAnchorElement>('a')];
            if (event.key === 'Escape') { close(); button.focus(); event.preventDefault(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const index = links.indexOf(document.activeElement as HTMLAnchorElement); open();
                links[index < 0 ? event.key === 'ArrowDown' ? 0 : links.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length].focus(); event.preventDefault();
            }
        };
        root.append(button, menu); nav.append(root); groups.push({ root, button, menu, pages: choices.map(c => c[0]) });
    }
    document.addEventListener('pointerdown', event => { if (!nav.contains(event.target as Node)) close(); });
    return (page: Page) => {
        close();
        for (const g of groups) { g.button.classList.toggle('current', g.pages.includes(page)); for (const link of g.menu.querySelectorAll('a')) { const active = link.hash === '#' + page; link.classList.toggle('current', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); } }
    };
}
