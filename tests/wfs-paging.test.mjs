import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelPages } from '../src/wfs-paging.ts';
import { defaultConfig, migrateSource, validateConfig } from '../src/source-settings.ts';

const collect = async options => {
    const pages = [];
    for await (const result of parallelPages({ pageSize: 2, limit: 100, maxParallelRequests: 10, featureCount: p => p.length, ...options })) pages.push(result);
    return pages;
};
function server({ size = 13, cap = () => Infinity, fail = () => false, delay = offset => offset === 2 ? 25 : 2 } = {}) {
    const state = { active: 0, peak: 0, requests: [], completed: [], aborted: [] };
    state.fetchPage = (offset, count, signal) => new Promise((resolve, reject) => {
        state.requests.push({ offset, count }); state.active++; state.peak = Math.max(state.peak, state.active);
        const finish = (aborted = false) => {
            clearTimeout(timer); signal.removeEventListener('abort', abort); state.active--;
            if (aborted) { state.aborted.push(offset); reject(new Error('aborted')); }
            else { state.completed.push(offset); if (fail(offset)) reject(Error(`failed ${offset}`));
                else resolve(Array.from({ length: Math.max(0, Math.min(count, cap(offset), size - offset)) }, (_, i) => offset + i)); }
        };
        const abort = () => finish(true), timer = setTimeout(finish, delay(offset));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    return state;
}
const rows = pages => pages.flatMap(p => p.page);
const expected = size => Array.from({ length: size }, (_, i) => i);

for (const concurrency of [1, 3, 10]) test(`parallel window ${concurrency} remains bounded and consumes out-of-order pages in order`, async () => {
    const s = server({ size: 17 });
    const pages = await collect({ fetchPage: s.fetchPage, maxParallelRequests: concurrency });
    assert.deepEqual(rows(pages), expected(17));
    assert.deepEqual(pages.map(p => p.offset), [0, 2, 4, 6, 8, 10, 12, 14, 16]);
    assert.equal(s.peak, concurrency); assert.equal(s.active, 0);
    if (concurrency > 1) assert.ok(s.completed.indexOf(4) < s.completed.indexOf(2));
});

test('fast later pages cannot expand the buffered window around a slow first outstanding page', async () => {
    let release;
    const requests = [], iterator = parallelPages({ pageSize: 2, limit: 100, maxParallelRequests: 3, featureCount: p => p.length,
        fetchPage: async (offset) => { requests.push(offset); if (offset === 2) await new Promise(r => release = r); return [offset, offset + 1]; } });
    assert.equal((await iterator.next()).value.offset, 0);
    const waiting = iterator.next();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(requests, [0, 2, 4, 6]);
    release(); await waiting; await iterator.return();
});

for (const cap of [() => 1, o => o === 0 ? 2 : o < 3 ? 1 : o < 12 ? 3 : 2]) test('server caps and changing nonterminal page sizes never skip or duplicate rows', async () => {
    const s = server({ size: 19, cap });
    const pages = await collect({ pageSize: 4, fetchPage: s.fetchPage, maxParallelRequests: 4 });
    assert.deepEqual(rows(pages), expected(19)); assert.equal(s.active, 0); assert.ok(s.peak <= 4);
});

for (const short of [false, true]) test(`ordered ${short ? 'short' : 'empty'} end ignores failures and rows beyond the boundary`, async () => {
    const s = server({ size: 3, fail: o => o >= 4, delay: o => o === 2 ? 25 : 1 });
    const pages = await collect({ fetchPage: s.fetchPage, stopOnShortPage: short });
    assert.deepEqual(rows(pages), expected(3)); assert.equal(s.active, 0);
    if (short) assert.ok(!s.requests.some(r => r.offset === 3));
    else assert.ok(s.requests.some(r => r.offset === 3));
});

test('short mode retains the first short page and does not request another', async () => {
    const s = server({ size: 100, cap: () => 1 });
    assert.deepEqual(rows(await collect({ fetchPage: s.fetchPage, stopOnShortPage: true })), [0]);
    assert.deepEqual(s.requests, [{ offset: 0, count: 2 }]);
});

test('an empty first page completes without speculation', async () => {
    const s = server({ size: 0 });
    assert.deepEqual(await collect({ fetchPage: s.fetchPage }), []);
    assert.equal(s.requests.length, 1); assert.equal(s.active, 0);
});

for (const limit of [1, 5, 6]) test(`client limit ${limit} bounds offsets, requested counts and output`, async () => {
    const s = server({ size: 100 });
    assert.deepEqual(rows(await collect({ fetchPage: s.fetchPage, limit })), expected(limit));
    assert.ok(s.requests.every(r => r.offset < limit && r.count === Math.min(2, limit - r.offset)));
    assert.equal(s.active, 0);
});

test('failure within the required range rejects, cancels and drains the other requests', async () => {
    const s = server({ fail: o => o === 2, delay: o => o < 4 ? 1 : 100 });
    await assert.rejects(collect({ fetchPage: s.fetchPage }), /failed 2/);
    assert.equal(s.active, 0); assert.ok(s.aborted.length > 0);
});

test('consumer failure also cancels and drains speculative requests', async () => {
    const s = server({ delay: o => o === 0 ? 1 : 100 });
    await assert.rejects((async () => {
        for await (const _ of parallelPages({ pageSize: 2, limit: 100, maxParallelRequests: 10, featureCount: p => p.length, fetchPage: s.fetchPage })) {
            await new Promise(r => setImmediate(r));
            throw Error('duplicate ID or packing failure');
        }
    })(), /packing failure/);
    assert.equal(s.active, 0); assert.equal(s.aborted.length, 10);
});

test('ignored requested count and malformed page reject safely', async () => {
    await assert.rejects(collect({ fetchPage: async () => [1, 2, 3] }), /ignored the requested page count/);
    await assert.rejects(collect({ fetchPage: async () => { throw Error('invalid JSON'); } }), /invalid JSON/);
});

test('legacy sources default to 10 and concurrency validation rejects invalid limits', async () => {
    globalThis.location = { href: 'https://example.org/', origin: 'https://example.org' };
    const config = { ...defaultConfig, url: '/wfs', layer: 'points' };
    delete config.maxParallelRequests;
    assert.equal(migrateSource({ name: 'Legacy', enabled: true, config }).config.maxParallelRequests, '10');
    for (const value of ['0', '-1', '1.5', '101', 'NaN', '']) {
        assert.throws(() => validateConfig({ ...config, maxParallelRequests: value }), /Maximum parallel requests/);
        await assert.rejects(collect({ fetchPage: async () => [], maxParallelRequests: Number(value) }), /Maximum parallel requests/);
    }
    for (const value of ['1', '10', '100']) validateConfig({ ...config, maxParallelRequests: value });
});
