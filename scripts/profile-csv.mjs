import { chromium } from '@playwright/test';
import { start } from '../server/server.ts';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const file = process.argv[2] ?? '/tmp/wfs-csv-stress/2m-16cols.csv';
const output = process.argv[3] ?? '/tmp/wfs-csv-stress/profile.json';
await mkdir(dirname(output), { recursive: true });
const report = { file, started: new Date().toISOString(), phases: [], samples: [], errors: [] };
const phase = name => { report.phases.push({ name, seconds: (performance.now() - started) / 1000 }); console.log(name); };
const started = performance.now();
const server = start(0); await once(server, 'listening');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
const browserCDP = await browser.newBrowserCDPSession();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('crash', () => { report.crashed = true; phase('renderer crashed'); });
page.on('pageerror', e => report.errors.push(e.stack ?? e.message));
const session = await page.context().newCDPSession(page);
await session.send('Profiler.enable'); await session.send('Profiler.start');
let commandId = 0;
const workerSessions = new Map(), commands = new Map();
session.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message), key = event.sessionId + ':' + message.id;
    const pending = commands.get(key);
    if (pending) { commands.delete(key); clearTimeout(pending.timer); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
});
function workerCommand(sessionId, method, params = {}) {
    const id = ++commandId, key = sessionId + ':' + id;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { commands.delete(key); reject(Error('Worker profiler timeout: ' + method)); }, 5000);
        commands.set(key, { resolve, reject, timer });
        void session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
}
session.on('Target.attachedToTarget', async event => {
    if (event.targetInfo.type !== 'worker') return;
    const entry = { sessionId: event.sessionId, url: event.targetInfo.url };
    workerSessions.set(event.sessionId, entry);
    try { await workerCommand(event.sessionId, 'Profiler.enable'); await workerCommand(event.sessionId, 'Profiler.start'); entry.started = true; } catch (e) { entry.error = String(e); }
});
await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
let busy = false;
const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
        const processes = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo;
        // Chromium reports namespace PIDs; /proc can expose host PIDs.
        const statuses = await Promise.all((await readdir('/proc')).filter(p => /^\d+$/.test(p)).map(async pid => {
            try { const status = await readFile('/proc/' + pid + '/status', 'utf8'); const ids = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number) ?? [Number(pid)]; return { pid: Number(pid), id: ids.at(-1), rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024 }; } catch { return null; }
        }));
        const memory = processes.map(p => ({ ...p, ...statuses.find(s => s?.id === p.id) }));
        const sample = { seconds: (performance.now() - started) / 1000, phase: report.phases.at(-1)?.name, processes: memory, totalRSSBytes: memory.reduce((n, p) => n + (p.rssBytes ?? 0), 0) };
        report.samples.push(sample);
        await writeFile(output, JSON.stringify(report, null, 2));
    } catch (e) { report.samplingError = String(e); } finally { busy = false; }
}, 500);
try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/?time=all#configuration');
    await page.locator('#addSource').click(); await page.locator('#sourceName').fill('2M stress CSV');
    await page.locator('#type').selectOption('csv'); phase('upload / header parsing');
    await page.locator('#csvFile').setInputFiles(file, { timeout: 300_000 });
    await Promise.race([page.waitForFunction(() => /16 columns/.test(document.querySelector('#csvFileStatus')?.textContent ?? ''), undefined, { timeout: 300_000 }), page.waitForEvent('crash', { timeout: 300_000 }).then(() => { throw Error('Renderer crashed during CSV header parsing'); })]);
    phase('columns ready');
    await page.locator('#csvTime').selectOption('timestamp'); await page.locator('#updateSource').click(); phase('saving CSV');
    await page.locator('#saveSettings').click(); await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === 'Saved in this browser', undefined, { timeout: 300_000 });
    phase('worker ingestion');
    await page.waitForFunction(() => window.__WFS_MAP__?.sources[0]?.done || window.__WFS_MAP__?.sources[0]?.error, undefined, { timeout: 300_000 });
    report.source = await page.evaluate(() => { const s = window.__WFS_MAP__.sources[0]; return { loaded: s.loaded, error: s.error, status: s.status, metrics: s.metrics }; });
    if (report.source.error || report.source.loaded !== 2_000_000) throw Error('CSV did not load all 2,000,000 rows.');
    phase('points loaded');
    await page.waitForFunction(() => !window.__WFS_MAP__.sources[0].filtering, undefined, { timeout: 300_000 });
    phase('analysis ready');
    report.heap = await session.send('Runtime.getHeapUsage');
    report.workers = [];
    for (const entry of workerSessions.values()) {
        try {
            entry.heap = await workerCommand(entry.sessionId, 'Runtime.getHeapUsage');
            if (entry.started) { const profile = await workerCommand(entry.sessionId, 'Profiler.stop'); await writeFile(output + '.worker-' + report.workers.length + '.cpuprofile', JSON.stringify(profile.profile)); }
        } catch (e) { entry.error = String(e); }
        report.workers.push(entry);
    }
    const profile = await session.send('Profiler.stop'); await writeFile(output + '.cpuprofile', JSON.stringify(profile.profile));
    await page.locator('#analysisLink').click(); await page.screenshot({ path: output + '.png' });
    report.renderer = await page.evaluate(() => window.__WFS_MAP__.metrics.renderer);
    report.success = true;
} catch (e) {
    report.failure = String(e); phase('failed');
    if (!report.crashed) try { const profile = await session.send('Profiler.stop'); await writeFile(output + '.cpuprofile', JSON.stringify(profile.profile)); } catch {}
} finally {
    clearInterval(timer);
    report.peakRSSBytes = Math.max(0, ...report.samples.map(s => s.totalRSSBytes));
    report.finished = new Date().toISOString();
    try { report.memoryEvents = await readFile('/sys/fs/cgroup/memory.events', 'utf8'); } catch {}
    await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ success: report.success, crashed: report.crashed, failure: report.failure, peakRSSBytes: report.peakRSSBytes, phases: report.phases }));
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
