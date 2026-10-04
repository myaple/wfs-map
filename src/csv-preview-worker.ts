import { parseCSV, previewCSV, type ParsedCSV, type CSVProgress } from './csv.ts';
import type { Config } from './source-settings.ts';
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let parsed: ParsedCSV | undefined;
ctx.onmessage = (e: MessageEvent<{ type: string; text: string; delimiter: string; config: Config; request: number }>) => {
    const m = e.data;
    const progress: CSVProgress = (stage, completed, total) => ctx.postMessage({ type: 'progress', request: m.request, stage, completed, total });
    try {
        if (m.type === 'parse') {
            parsed = parseCSV(m.text, m.delimiter, true, progress);
            ctx.postMessage({ type: 'headers', request: m.request, headers: parsed.headers });
        } else if (parsed) ctx.postMessage({ type: 'preview', request: m.request, report: previewCSV(m.config, parsed, progress) });
    } catch (e) { ctx.postMessage({ type: 'error', request: m.request, message: (e as Error).message }); }
};
