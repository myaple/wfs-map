import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createBackup, readBackup } from '../src/source-backup.ts';
import { packArchive } from '../src/backup-archive.ts';
import { defaultConfig } from '../src/source-settings.ts';

globalThis.location = { href: 'https://analyst.example/app', origin: 'https://analyst.example' };
const csv = '\uFEFFlon;lat;name;notes\r\n-1;54;"a;b";"first\nsecond ""quote"" café ☁"\r\n-2;53;other;\r\n';
const settings = () => ({
    sources: [
        { id: 'csv-one', name: 'Points', enabled: true, color: [0.1, 0.2, 0.3],
            coloring: { field: 'name', bins: 24, low: '#112233', high: '#445566', categories: { name: { 'a;b': '#abcdef', other: '#123456' } } },
            config: { ...defaultConfig, type: 'csv', csvRef: 'local-ref', fileName: 'shared.csv', delimiter: ';', longitudeField: 'lon', latitudeField: 'lat' } },
        { id: 'disabled-csv', name: 'Disabled file', enabled: false,
            config: { ...defaultConfig, type: 'csv', csvText: 'geom\tvalue\nPOINT (-2 53)\t99\n', fileName: 'wkt.tsv', delimiter: '\t', geometryMode: 'wkt', geometryField: 'geom' } },
        { id: 'wfs-one', name: 'Daily WFS', enabled: false,
            config: { ...defaultConfig, url: 'https://example.org/wfs?vendor=keep&token=example', layer: 'team:observations', version: '1.1.0', axis: 'yx', pageSize: '1234', limit: '9999', timeField: 'observed', geometryField: 'geom', sort: 'identifier' } }
    ],
    background: { url: 'https://tiles.example/{z}/{x}/{y}.png?style=one', attribution: 'Example ©', enabled: true },
    map: { center: [-1.54, 53.99], zoom: 12.5, pointSize: 4.5 }
});
const normalized = value => ({ ...value, sources: value.sources.map(s => ({ ...s, config: { ...s.config, csvRef: '', csvText: s.config.type === 'csv' && s.id === 'csv-one' ? csv : s.config.csvText } })) });

test('tar.gz export/import round trip retains every CSV row and all source and map settings', async () => {
    const before = settings(), untouched = structuredClone(before), reads = [];
    const archive = await createBackup(before, async ref => { reads.push(ref); return csv; });
    assert.deepEqual(reads, ['local-ref']); assert.deepEqual(before, untouched);
    const bytes = Buffer.from(await archive.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
    // Independently prove this is a standard tar.gz, with original CSV text and
    // WFS settings only (no fetched features or browser-specific references).
    assert.equal(execFileSync('tar', ['-tzf', '-'], { input: bytes, encoding: 'utf8' }), 'manifest.json\ncsv/source-1.csv\ncsv/source-2.csv\n');
    assert.equal(execFileSync('tar', ['-xOzf', '-', 'csv/source-1.csv'], { input: bytes, encoding: 'utf8' }), csv);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', '-', 'manifest.json'], { input: bytes, encoding: 'utf8' }));
    assert.ok(manifest.settings.sources.every(s => s.config.csvText === '' && s.config.csvRef === ''));
    const after = await readBackup(archive);
    assert.deepEqual(normalized(after), normalized(before));
    assert.notEqual(after.sources[0].config.csvRef, 'local-ref');
    assert.notEqual(after.sources[0].config.csvRef, after.sources[1].config.csvRef);
    const second = await readBackup(await createBackup(after, () => { throw Error('Inline restored CSV must take priority'); }));
    assert.deepEqual(normalized(second), normalized(after));
    assert.notEqual(second.sources[0].config.csvRef, after.sources[0].config.csvRef);
});

test('empty source sets and WFS-only backups work without CSV storage', async () => {
    for (const sources of [[], [settings().sources[2]]]) {
        const before = { ...settings(), sources };
        assert.deepEqual(await readBackup(await createBackup(before, () => { throw Error('No CSV reads'); })), before);
    }
});

test('large CSV backups use original file contents, including disabled data', async () => {
    const before = settings(), large = 'lon;lat;name;notes\n' + '-1;54;full;metadata\n'.repeat(350_000);
    before.sources[0].enabled = false;
    const restored = await readBackup(await createBackup(before, async () => large));
    assert.equal(restored.sources[0].config.csvText, large);
    assert.equal(restored.sources[0].enabled, false);
});

test('missing CSV storage prevents incomplete exports', async () => {
    await assert.rejects(createBackup(settings(), async () => { throw Error('File missing'); }), /File missing/);
});

async function modifiedBackup(edit, editFiles = () => {}) {
    const archive = await createBackup(settings(), async () => csv);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', '-', 'manifest.json'], { input: Buffer.from(await archive.arrayBuffer()), encoding: 'utf8' }));
    edit(manifest);
    const files = new Map([['manifest.json', new Blob([JSON.stringify(manifest)])], ['csv/source-1.csv', new Blob([csv])], ['csv/source-2.csv', new Blob([settings().sources[1].config.csvText])]]);
    editFiles(files);
    return packArchive(files);
}

test('unsupported, incomplete and invalid manifests are rejected', async () => {
    const cases = [
        [m => m.version = 2, /version/],
        [m => m.settings.sources[1].id = 'csv-one', /more than once|duplicate/],
        [m => m.settings.sources[2].config.url = 'javascript:alert(1)', /HTTP/],
        [m => m.settings.map.zoom = 99, /map view/],
        [m => m.settings.sources[0].color = ['bad', 0, 0], /colour/],
        [m => m.settings.sources[0].config.csvRef = 'browser-local', /local CSV/],
        [m => m.csvFiles['wfs-one'] = 'csv/source-1.csv', /unexpected/],
        [m => m.csvFiles['csv-one'] = '../private.csv', /missing a CSV/]
    ];
    for (const [edit, error] of cases) await assert.rejects(readBackup(await modifiedBackup(edit)), error);
    await assert.rejects(readBackup(await modifiedBackup(() => {}, f => f.delete('csv/source-1.csv'))), /missing a CSV/);
    await assert.rejects(readBackup(await modifiedBackup(() => {}, f => f.set('extra.txt', new Blob(['unexpected'])))), /unexpected files/);
    await assert.rejects(readBackup(await modifiedBackup(() => {}, f => f.set('csv/source-1.csv', new Blob([])))), /empty CSV/);
});

test('corruption, truncation, unsafe paths, duplicates, links and oversized headers fail', async () => {
    const archive = await createBackup(settings(), async () => csv), bytes = Buffer.from(await archive.arrayBuffer());
    await assert.rejects(readBackup(new Blob(['not gzip'])));
    await assert.rejects(readBackup(new Blob([bytes.subarray(0, bytes.length - 8)])));
    const tar = gunzipSync(bytes);
    const checksum = header => { header.fill(32, 148, 156); const sum = header.subarray(0, 512).reduce((n, b) => n + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); };
    for (const edit of [
        b => b[0] ^= 1,
        b => { b.fill(0, 0, 100); b.write('../manifest.json'); checksum(b); },
        b => { b[156] = 50; checksum(b); },
        b => { b.write((2 ** 31).toString(8).padStart(11, '0') + '\0', 124); checksum(b); }
    ]) {
        const changed = Buffer.from(tar); edit(changed);
        await assert.rejects(readBackup(new Blob([gzipSync(changed)])));
    }
    const manifestSize = parseInt(tar.subarray(124, 136).toString().replace(/\0/g, ''), 8);
    const firstEnd = 512 + Math.ceil(manifestSize / 512) * 512;
    await assert.rejects(readBackup(new Blob([gzipSync(Buffer.concat([tar.subarray(0, firstEnd), tar]))])), /duplicate/);
    await assert.rejects(readBackup(new Blob([gzipSync(tar.subarray(0, tar.length - 512))])), /truncated/);
});

test('CSV import choices survive backup; old version-1 archives gain safe defaults', async () => {
    const before = settings();
    Object.assign(before.sources[0].config, { csvTypes: '{"name":"string"}', csvMissingValues: '["","N/A","unknown"]', csvInvalidRows: 'quarantine' });
    const after = await readBackup(await createBackup(before, async () => csv));
    assert.deepEqual(normalized(after), normalized(before));
    const archive = await createBackup(settings(), async () => csv);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', '-', 'manifest.json'], { input: Buffer.from(await archive.arrayBuffer()), encoding: 'utf8' }));
    for (const source of manifest.settings.sources) for (const key of ['csvTypes', 'csvMissingValues', 'csvInvalidRows']) delete source.config[key];
    const legacy = await packArchive(new Map([['manifest.json', new Blob([JSON.stringify(manifest)])], ['csv/source-1.csv', new Blob([csv])], ['csv/source-2.csv', new Blob([settings().sources[1].config.csvText])]]));
    const restored = await readBackup(legacy);
    assert.equal(restored.sources[0].config.csvTypes, '{}');
    assert.equal(restored.sources[0].config.csvInvalidRows, 'reject');
    assert.equal(restored.sources[0].config.csvText, csv);
});
