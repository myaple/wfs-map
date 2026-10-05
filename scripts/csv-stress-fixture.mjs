import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export async function csvStressFixture(path, rows = 2_000_000) {
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > 2_000_000) throw Error('Rows must be between 1 and 2,000,000.');
    await mkdir(dirname(path), { recursive: true });
    const headers = ['longitude', 'latitude', 'timestamp', 'unique_a', 'unique_b', ...Array.from({ length: 11 }, (_, i) => 'n' + String(i + 1).padStart(2, '0'))];
    const output = createWriteStream(path);
    const done = once(output, 'finish');
    const header = headers.join(',') + '\n';
    output.write(header);
    for (let offset = 0; offset < rows; offset += 10_000) {
        const batch = [];
        for (let i = offset; i < Math.min(rows, offset + 10_000); i++) {
            const longitude = (-1 - (i % 300_000) / 100_000).toFixed(5);
            const latitude = (51 + (i % 300_000) / 100_000).toFixed(5);
            const stamp = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString().replace('.000Z', 'Z');
            const cells = [longitude, latitude, stamp, 'a-' + String(i).padStart(16, '0'), 'b-' + String(i).padStart(17, '0'), ...Array.from({ length: 11 }, (_, j) => String((i + j) % 10))];
            batch.push(cells.join(',') + '\n');
        }
        if (!output.write(batch.join(''))) await once(output, 'drain');
    }
    output.end(); await done;
    const bytes = (await stat(path)).size;
    if (bytes !== Buffer.byteLength(header) + rows * 100) throw Error('Fixture did not have 100-byte records.');
    return { path, rows, columns: headers.length, uniqueStringColumns: ['unique_a', 'unique_b'], bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await csvStressFixture(process.argv[2] ?? '/tmp/wfs-csv-stress/2m-16cols.csv', Number(process.argv[3] ?? 2_000_000))));
