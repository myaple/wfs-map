/** Keep the normal map and its legend above the fixed workspace controls. */
export function fitMapPanel(panel: HTMLElement) {
    const grid = panel.parentElement!;
    const dock = document.getElementById('workspaceDock')!;
    const footer = document.getElementById('page-footer')!;
    let frame = 0;
    const update = () => {
        frame = 0;
        if (!grid.getClientRects().length || panel.closest('dialog')) return;
        // Use the grid's document position so scrolling through charts doesn't
        // change the map size or shift the page underneath the cursor.
        const top = grid.getBoundingClientRect().top + window.scrollY;
        const bottom = dock.getBoundingClientRect().height + footer.getBoundingClientRect().height + 12;
        panel.style.setProperty('--map-panel-height', `${Math.max(0, window.innerHeight - top - bottom)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    for (const element of [grid, dock, footer, document.querySelector<HTMLElement>('.topbar')!, document.querySelector<HTMLElement>('.load-strip')!]) observer.observe(element);
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    window.addEventListener('timelinehost', schedule);
    schedule();
}
