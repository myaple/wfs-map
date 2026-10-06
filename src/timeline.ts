import { formatUTC, parseUTC } from './time.ts';
import { moveWindow, resizeWindow, type TimeWindow, type TimelineExtent } from './timeline-data.ts';

export class Timeline {
    readonly root = document.createElement('section');
    window?: TimeWindow;
    private extent?: TimeWindow;
    private pendingWindow?: TimeWindow;
    get savedWindow() { return this.pendingWindow ?? this.window; }
    restoreWindow(window?: TimeWindow) { this.pendingWindow = window ? { ...window } : undefined; }
    private signature = '';
    private frame = 0;
    private track: HTMLElement;
    private selection: HTMLElement;
    private start: HTMLInputElement;
    private end: HTMLInputElement;
    private toggle: HTMLInputElement;
    private anchor = document.createComment('timeline position');
    constructor(host: HTMLElement, private changed: () => void) {
        this.root.className = 'timeline';
        this.root.setAttribute('aria-label', 'Loaded data timeline');
        this.root.innerHTML = `<div class="timeline-heading"><strong>Timeline</strong><span class="hint">Loaded data only · UTC</span><label><input class="timeline-toggle" type="checkbox"> Use time window</label><button class="timeline-reset" type="button">Show all loaded times</button></div>
<form class="timeline-controls"><label>From (UTC)<input class="timeline-start" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-label="Timeline start (UTC)"></label><span aria-hidden="true">→</span><label>To (UTC)<input class="timeline-end" type="text" placeholder="YYYY-MM-DD HH:mm:ss" aria-label="Timeline end (UTC)"></label><button type="submit">Set window</button><span class="timeline-duration hint"></span></form>
<div class="timeline-track" aria-label="Time extent"><div class="timeline-selection"><button type="button" class="timeline-handle" data-edge="start" role="slider" aria-label="Timeline start handle" aria-orientation="horizontal"></button><button type="button" class="timeline-window" role="slider" aria-label="Move time window" aria-orientation="horizontal"><span aria-hidden="true">↔</span></button><button type="button" class="timeline-handle" data-edge="end" role="slider" aria-label="Timeline end handle" aria-orientation="horizontal"></button></div></div>
<div class="timeline-axis hint"><span></span><span></span></div><p class="timeline-help hint">Drag the window to move through time; drag either edge to resize. Arrow keys move or resize; Shift moves faster.</p><p class="timeline-status hint"></p><p class="timeline-error error" role="alert" hidden></p>`;
        const body = document.createElement('div'); body.className = 'timeline-body'; body.id = 'timelineBody'; body.hidden = true;
        body.append(...this.root.children);
        const bar = document.createElement('div'); bar.className = 'timeline-bar';
        const collapse = document.createElement('button'); collapse.id = 'toggleTimeline'; collapse.type = 'button';
        collapse.textContent = 'Timeline'; collapse.setAttribute('aria-expanded', 'false'); collapse.setAttribute('aria-controls', body.id);
        const summary = document.createElement('span'); summary.className = 'timeline-summary hint'; summary.setAttribute('role', 'status');
        collapse.onclick = () => { body.hidden = !body.hidden; collapse.setAttribute('aria-expanded', String(!body.hidden)); };
        bar.append(collapse, summary); this.root.append(bar, body);
        host.before(this.anchor, this.root);
        this.track = this.root.querySelector('.timeline-track')!;
        this.selection = this.root.querySelector('.timeline-selection')!;
        this.start = this.root.querySelector('.timeline-start')!;
        this.end = this.root.querySelector('.timeline-end')!;
        this.toggle = this.root.querySelector('.timeline-toggle')!;
        this.toggle.onchange = () => { this.window = this.toggle.checked && this.extent ? { ...this.extent } : undefined; this.commit(); };
        this.root.querySelector<HTMLButtonElement>('.timeline-reset')!.onclick = () => { this.window = undefined; this.commit(); };
        this.root.querySelector('form')!.onsubmit = event => {
            event.preventDefault();
            const start = parseUTC(this.start.value), end = parseUTC(this.end.value), extent = this.extent;
            const error = this.root.querySelector<HTMLElement>('.timeline-error')!;
            error.hidden = !!extent && Number.isFinite(start) && Number.isFinite(end) && start <= end && start >= extent.start && end <= extent.end;
            if (!error.hidden) { error.textContent = 'Enter a valid UTC window within the loaded time extent, with start at or before end.'; return; }
            this.window = { start, end }; this.commit();
        };
        let drag: { pointer: number; x: number; width: number; edge?: 'start' | 'end'; initial: TimeWindow; previous?: TimeWindow } | undefined;
        this.track.onpointerdown = event => {
            if (event.button !== 0 || !this.extent || this.extent.start === this.extent.end) return;
            event.preventDefault();
            const rect = this.track.getBoundingClientRect(), target = event.target as HTMLElement;
            const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge as 'start' | 'end' | undefined;
            const previous = this.window ? { ...this.window } : undefined;
            if (!target.closest('.timeline-selection')) {
                const width = this.window ? this.window.end - this.window.start : (this.extent.end - this.extent.start) / 4;
                const center = this.extent.start + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (this.extent.end - this.extent.start);
                this.window = moveWindow({ start: this.extent.start, end: this.extent.start + width }, this.extent, center - width / 2 - this.extent.start);
            } else this.window ??= { ...this.extent };
            drag = { pointer: event.pointerId, x: event.clientX, width: rect.width, edge, initial: { ...this.window }, previous };
            this.track.setPointerCapture(event.pointerId);
            (edge ? this.selection.querySelector<HTMLElement>(`[data-edge=${edge}]`) : this.selection.querySelector<HTMLElement>('.timeline-window'))?.focus({ preventScroll: true });
            this.commit();
        };
        this.track.onpointermove = event => {
            if (!drag || drag.pointer !== event.pointerId || !this.extent) return;
            const delta = Math.round((event.clientX - drag.x) / drag.width * (this.extent.end - this.extent.start));
            this.window = drag.edge ? resizeWindow(drag.initial, this.extent, drag.edge, drag.initial[drag.edge] + delta) : moveWindow(drag.initial, this.extent, delta);
            this.commit();
        };
        this.track.onpointerup = event => { if (drag?.pointer === event.pointerId) { drag = undefined; this.track.releasePointerCapture(event.pointerId); } };
        this.track.onpointercancel = () => { if (drag) { this.window = drag.previous; drag = undefined; this.commit(); } };
        this.track.onlostpointercapture = () => { drag = undefined; };
        this.selection.onkeydown = event => {
            if (!this.extent || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const window = this.window ?? this.extent;
            const edge = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
            const delta = Math.max(1, Math.round((this.extent.end - this.extent.start) / (event.shiftKey ? 10 : 1000))) * (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1);
            if (edge) this.window = resizeWindow(window, this.extent, edge, event.key === 'Home' ? this.extent.start : event.key === 'End' ? this.extent.end : window[edge] + delta);
            else this.window = moveWindow(window, this.extent, event.key === 'Home' ? this.extent.start - window.start : event.key === 'End' ? this.extent.end - window.end : delta);
            this.commit();
        };
        window.addEventListener('timelinehost', event => {
            const dialog = (event as CustomEvent<HTMLDialogElement | undefined>).detail;
            if (dialog) dialog.append(this.root); else this.anchor.after(this.root);
        });
        this.paint();
    }
    update(sources: { name: string; extent?: TimelineExtent; loaded: number }[], restoreComplete = true) {
        const signature = JSON.stringify([sources, restoreComplete]);
        if (signature === this.signature) return;
        this.signature = signature;
        const dated = sources.filter(s => s.extent?.valid), previous = this.window;
        this.extent = dated.length ? { start: Math.min(...dated.map(s => s.extent!.start)), end: Math.max(...dated.map(s => s.extent!.end)) } : undefined;
        if (this.extent && this.pendingWindow) { this.window = { ...this.pendingWindow }; if (restoreComplete) this.pendingWindow = undefined; }
        if (!this.extent) this.window = undefined;
        else if (this.window) this.window = { start: Math.max(this.extent.start, Math.min(this.extent.end, this.window.start)), end: Math.max(this.extent.start, Math.min(this.extent.end, this.window.end)) };
        const untimed = sources.filter(s => s.loaded && !s.extent?.valid).map(s => s.name);
        const missing = sources.reduce((n, s) => n + (s.extent?.missing ?? 0), 0);
        this.root.querySelector('.timeline-status')!.textContent = !this.extent ? 'Load data with a time attribute to use the timeline. Choose the time attribute in Data sources when needed.' : `${dated.length} timed source${dated.length === 1 ? '' : 's'}${missing ? ` · ${missing.toLocaleString()} missing/invalid times excluded when active` : ''}${untimed.length ? ` · No valid times (shown unchanged): ${untimed.join(', ')}` : ''}`;
        if (JSON.stringify(previous) !== JSON.stringify(this.window)) this.commit(true); else this.paint();
    }
    private commit(restoring = false) {
        if (!restoring) this.pendingWindow = undefined;
        if (this.window) this.window = { start: Math.round(this.window.start), end: Math.round(this.window.end) };
        this.root.querySelector<HTMLElement>('.timeline-error')!.hidden = true;
        this.paint();
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.changed(); });
    }
    private paint() {
        const extent = this.extent, window = this.window ?? extent;
        this.toggle.checked = !!this.window;
        this.root.classList.toggle('timeline-active', !!this.window);
        for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.timeline-body input, .timeline-body button')) control.disabled = !extent;
        this.root.querySelector('.timeline-summary')!.textContent = this.window ? `${formatUTC(this.window.start)} to ${formatUTC(this.window.end)}` : extent ? 'All loaded times · UTC' : 'Load timed data to use the timeline';
        const span = extent ? extent.end - extent.start : 0;
        this.selection.style.left = `${window && extent && span ? (window.start - extent.start) / span * 100 : 0}%`;
        this.selection.style.right = `${window && extent && span ? (extent.end - window.end) / span * 100 : 0}%`;
        this.start.value = window ? new Date(window.start).toISOString().slice(0, -1).replace('T', ' ') : '';
        this.end.value = window ? new Date(window.end).toISOString().slice(0, -1).replace('T', ' ') : '';
        const duration = window ? (window.end - window.start) / 1000 : 0;
        this.root.querySelector('.timeline-duration')!.textContent = window ? `Window: ${duration >= 86400 ? (duration / 86400).toFixed(2) + ' days' : duration >= 3600 ? (duration / 3600).toFixed(2) + ' hours' : duration >= 60 ? (duration / 60).toFixed(2) + ' minutes' : duration + ' seconds'}` : '';
        const axis = this.root.querySelector('.timeline-axis')!;
        axis.children[0].textContent = extent ? formatUTC(extent.start) : 'No loaded times';
        axis.children[1].textContent = extent ? formatUTC(extent.end) : '';
        for (const handle of this.selection.querySelectorAll<HTMLElement>('[role=slider]')) {
            const edge = handle.dataset.edge as 'start' | 'end' | undefined;
            handle.setAttribute('aria-valuemin', String(edge === 'end' ? window?.start ?? 0 : extent?.start ?? 0));
            handle.setAttribute('aria-valuemax', String(edge === 'start' ? window?.end ?? 0 : edge === 'end' ? extent?.end ?? 0 : extent && window ? extent.end - (window.end - window.start) : 0));
            handle.setAttribute('aria-valuenow', String(window?.[edge ?? 'start'] ?? 0));
            handle.setAttribute('aria-valuetext', window ? edge ? formatUTC(window[edge]) : `${formatUTC(window.start)} to ${formatUTC(window.end)}` : 'No loaded times');
        }
    }
}
