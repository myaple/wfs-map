import { settingsKey, settingsMetadata, type Settings } from './source-settings.ts';

const databaseName = 'wfs-source-files', storeName = 'csv';
function openFiles(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => {
            if (blocked) { request.result.close(); return; }
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => { blocked = true; reject(Error('Close other app tabs and try saving again.')); };
    });
}
function completed(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? Error('CSV storage transaction was interrupted.'));
        transaction.onerror = () => {}; // Abort reports the transaction error.
    });
}
export async function readCSVText(reference: string): Promise<string> {
    const db = await openFiles();
    try {
        const transaction = db.transaction(storeName, 'readonly'), done = completed(transaction);
        const request = transaction.objectStore(storeName).get(reference);
        await done;
        if (!(request.result instanceof Blob)) throw Error('The saved CSV file is missing. Choose the file again in Data sources.');
        return await request.result.text();
    } finally { db.close(); }
}
function references(settings: Settings): Set<string> {
    return new Set(settings.sources.filter(s => s.config.type === 'csv' && s.config.csvRef).map(s => s.config.csvRef));
}
async function removeFiles(db: IDBDatabase, keys: Iterable<string>) {
    const transaction = db.transaction(storeName, 'readwrite'), done = completed(transaction);
    for (const key of keys) transaction.objectStore(storeName).delete(key);
    await done;
}
export async function saveSettings(settings: Settings): Promise<Settings> {
    const next = settingsMetadata(settings), files = settings.sources.filter(s => s.config.type === 'csv');
    let previous: Settings | undefined;
    try { previous = JSON.parse(localStorage.getItem(settingsKey) ?? 'null') ?? undefined; } catch { }
    const oldRefs = previous?.sources ? references(previous) : new Set<string>();
    for (const [index, source] of settings.sources.entries()) {
        if (source.config.type === 'csv' && !next.sources[index].config.csvRef) next.sources[index].config.csvRef = crypto.randomUUID();
    }
    // WFS-only settings keep working even when IndexedDB is unavailable.
    if (!files.length && !oldRefs.size) {
        localStorage.setItem(settingsKey, JSON.stringify(next));
        return next;
    }
    const db = await openFiles(), added: string[] = [];
    let published = false;
    try {
        const transaction = db.transaction(storeName, 'readwrite'), done = completed(transaction), store = transaction.objectStore(storeName);
        let missing = false;
        for (const source of files) {
            const ref = next.sources.find(s => s.id === source.id)!.config.csvRef;
            const payload = source.config.csvText ? new Blob([source.config.csvText], { type: 'text/csv' }) : undefined;
            const request = store.getKey(ref);
            request.onsuccess = () => {
                if (request.result !== undefined) return;
                if (!payload) {
                    if (settingsKey !== 'wfs-settings') return; // Shared setup may await local attachment.
                    missing = true; transaction.abort(); return;
                }
                // Never overwrite the file used by the currently saved settings.
                store.add(payload, ref); added.push(ref);
            };
        }
        try { await done; }
        catch (e) { if (missing) throw Error('The saved CSV file is missing. Choose the file again in Data sources.'); throw e; }
        // Publishing one small pointer is atomic. A failed metadata write still
        // leaves every file referenced by the previous settings untouched.
        localStorage.setItem(settingsKey, JSON.stringify(next));
        published = true;
        const keep = references(next);
        // Named analyses may share local blobs across tabs and copies. Retain them
        // rather than deleting a file another analysis still needs.
        if (settingsKey === 'wfs-settings') {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)!;
                if (!key.startsWith('wfs-analysis-settings:') || key.endsWith(':bindings')) continue;
                try { for (const ref of references(JSON.parse(localStorage.getItem(key)!))) keep.add(ref); } catch {}
            }
            await removeFiles(db, [...oldRefs].filter(ref => !keep.has(ref))).catch(() => {});
        }
        return next;
    } catch (e) {
        if (!published) await removeFiles(db, added).catch(() => {});
        throw e;
    } finally { db.close(); }
}
