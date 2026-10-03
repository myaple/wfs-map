// A deliberately small USTAR subset: regular files only, generated safe paths,
// and checksummed headers. Payloads stay in Blob parts rather than one tar buffer.
const block = 512;
export const maxBackupBytes = 1024 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function safePath(path: string) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) && path.length < 100 && !path.split('/').some(p => !p || p === '.' || p === '..');
}
function checksum(header: Uint8Array) {
    return header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
}
export async function packArchive(files: Map<string, Blob>): Promise<Blob> {
    const parts: BlobPart[] = [];
    let bytes = 2 * block;
    for (const [path, file] of files) {
        if (!safePath(path)) throw Error('Invalid backup file path.');
        bytes += block + Math.ceil(file.size / block) * block;
        if (bytes > maxBackupBytes) throw Error('Backup exceeds the 1 GiB uncompressed limit.');
        const header = new Uint8Array(block);
        const write = (offset: number, text: string) => header.set(encoder.encode(text), offset);
        const octal = (offset: number, length: number, value: number) => write(offset, value.toString(8).padStart(length - 1, '0') + '\0');
        write(0, path); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
        octal(124, 12, file.size); octal(136, 12, 0);
        write(148, '        '); write(156, '0'); write(257, 'ustar\0'); write(263, '00');
        write(148, checksum(header).toString(8).padStart(6, '0') + '\0 ');
        parts.push(header, file, new Uint8Array((block - file.size % block) % block));
    }
    parts.push(new Uint8Array(2 * block));
    return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
export async function unpackArchive(archive: Blob): Promise<Map<string, Blob>> {
    if (archive.size > maxBackupBytes) throw Error('Backup exceeds the 1 GiB limit.');
    const reader = archive.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(), offset = 0, bytes = 0;
    async function take(size: number): Promise<Blob> {
        const parts: BlobPart[] = [];
        while (size) {
            if (offset === chunk.length) {
                const next = await reader.read();
                if (next.done) throw Error('Backup archive is truncated.');
                chunk = next.value; offset = 0; bytes += chunk.length;
                if (bytes > maxBackupBytes) throw Error('Backup exceeds the 1 GiB uncompressed limit.');
            }
            const count = Math.min(size, chunk.length - offset);
            parts.push(chunk.slice(offset, offset + count)); offset += count; size -= count;
        }
        return new Blob(parts);
    }
    const text = (header: Uint8Array, start: number, length: number) => decoder.decode(header.subarray(start, start + length)).split('\0')[0];
    const number = (header: Uint8Array, start: number, length: number) => {
        const value = text(header, start, length).trim();
        if (!/^[0-7]+$/.test(value)) throw Error('Invalid tar header.');
        const n = parseInt(value, 8);
        if (!Number.isSafeInteger(n) || n > maxBackupBytes) throw Error('Invalid tar file size.');
        return n;
    };
    const files = new Map<string, Blob>();
    try {
        while (true) {
            const header = new Uint8Array(await (await take(block)).arrayBuffer());
            if (header.every(byte => byte === 0)) {
                const end = new Uint8Array(await (await take(block)).arrayBuffer());
                if (end.some(byte => byte !== 0)) throw Error('Invalid tar end marker.');
                // Drain to verify gzip CRC/trailer and reject trailing non-zero data.
                if (chunk.subarray(offset).some(byte => byte !== 0)) throw Error('Unexpected data after tar end marker.');
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    bytes += next.value.length;
                    if (bytes > maxBackupBytes || next.value.some(byte => byte !== 0)) throw Error('Invalid trailing archive data.');
                }
                return files;
            }
            const path = text(header, 0, 100);
            if (!safePath(path) || files.has(path)) throw Error('Invalid or duplicate backup file path.');
            if (checksum(header) !== number(header, 148, 8)) throw Error('Tar header checksum does not match.');
            if (text(header, 257, 6) !== 'ustar' || text(header, 345, 155) || ![0, 48].includes(header[156])) throw Error('Backup must contain only regular USTAR files.');
            if (files.size >= 9) throw Error('Backup contains too many files.');
            const size = number(header, 124, 12);
            if (path === 'manifest.json' && size > 1024 * 1024) throw Error('Backup manifest is too large.');
            files.set(path, await take(size));
            const padding = new Uint8Array(await (await take((block - size % block) % block)).arrayBuffer());
            if (padding.some(byte => byte !== 0)) throw Error('Invalid tar padding.');
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
