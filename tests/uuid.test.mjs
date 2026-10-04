import test from 'node:test';
import assert from 'node:assert/strict';
import { createUUID } from '../src/uuid.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('UUID generation uses the native method when available', t => {
    const native = t.mock.method(crypto, 'randomUUID', () => 'native-uuid');
    assert.equal(createUUID(), 'native-uuid');
    assert.equal(native.mock.callCount(), 1);
});

test('HTTP fallback creates distinct v4 UUIDs without randomUUID', t => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    t.after(() => descriptor ? Object.defineProperty(crypto, 'randomUUID', descriptor) : delete crypto.randomUUID);
    const ids = Array.from({ length: 1024 }, createUUID);
    for (const id of ids) assert.match(id, uuidV4);
    assert.equal(new Set(ids).size, ids.length);
});

test('HTTP fallback preserves leading zeros and sets UUID version and variant bits', t => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    t.after(() => descriptor ? Object.defineProperty(crypto, 'randomUUID', descriptor) : delete crypto.randomUUID);
    t.mock.method(crypto, 'getRandomValues', bytes => bytes.fill(0));
    assert.equal(createUUID(), '00000000-0000-4000-8000-000000000000');
    t.mock.method(crypto, 'getRandomValues', bytes => bytes.fill(255));
    assert.equal(createUUID(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});
