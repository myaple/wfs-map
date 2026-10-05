/** One live filter editor and timeline shared by all workspace pages. */
export function mountWorkspacePanels(app: HTMLElement, query: HTMLElement, filters: HTMLElement, timeline: HTMLElement, resized: () => void) {
    const layout = document.createElement('div'); layout.className = 'workspace-layout';
    const pages = document.createElement('div'); pages.className = 'workspace-pages';
    for (const id of ['analysis', 'records', 'configuration', 'derived']) pages.append(document.getElementById(id)!);
    const sidebar = document.createElement('aside'); sidebar.id = 'workspaceFilters'; sidebar.className = 'workspace-filters'; sidebar.setAttribute('aria-label', 'Workspace filters');
    const button = document.createElement('button'); button.id = 'toggleFilters'; button.type = 'button'; button.textContent = 'Filters';
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'workspaceFilterContent');
    const content = document.createElement('div'); content.id = 'workspaceFilterContent'; content.className = 'analysis-controls'; content.hidden = true;
    content.append(query, filters); sidebar.append(button, content); layout.append(pages, sidebar);
    app.insertBefore(layout, timeline.previousSibling);
    const setOpen = (open: boolean) => {
        content.hidden = !open; button.setAttribute('aria-expanded', String(open)); layout.classList.toggle('filters-open', open);
    };
    button.onclick = () => setOpen(content.hidden);
    sidebar.onkeydown = event => {
        if (event.key === 'Escape' && !content.hidden) { setOpen(false); button.focus(); event.stopPropagation(); }
    };
    // Colouring belongs alongside export, below the dashboard's map and charts.
    const footer = document.createElement('div'); footer.className = 'dashboard-footer';
    const colouring = pages.querySelector<HTMLElement>('.colour-panel')!;
    const csv = pages.querySelector<HTMLElement>('.csv-export-panel')!;
    csv.before(footer); footer.append(colouring, csv);
    pages.querySelector('#analysis > .analysis-controls')?.remove();
    let frame = 0;
    new ResizeObserver(() => {
        app.style.setProperty('--timeline-height', `${timeline.closest('dialog') ? 0 : timeline.getBoundingClientRect().height}px`);
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; resized(); });
    }).observe(timeline);
    new ResizeObserver(() => {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; resized(); });
    }).observe(pages);
}
