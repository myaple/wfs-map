import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryHistory } from '../src/query-history.ts';
import { Analyzer } from '../src/analysis.ts';
import { Store } from '../src/store.ts';
import { inferFields } from '../src/data.ts';

const nested = { op: 'and', children: [
    { op: 'or', children: [{ field: 'kind', op: 'eq', value: 'a' }, { field: 'kind', op: 'eq', value: 'b' }] },
    { field: 'n', op: 'gte', value: '2' }
] };
test('committed history clones nested predicates, branches redo and isolates sources', async () => {
    const a = new QueryHistory(), b = new QueryHistory();
    const rows = [['a', 1], ['b', 2], ['a', 3], ['c', 4]].map(([kind, n], i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { kind, n } }));
    const store = new Store(inferFields(rows)); store.append(rows); store.finish();
    const analyzer = new Analyzer(store);
    a.commit(nested);
    assert.deepEqual([...(await analyzer.run(a.applied, [])).indices], [1, 2]);
    const second = { op: 'or', children: [nested, { field: 'n', op: 'eq', value: '4' }] };
    a.commit(second);
    assert.deepEqual([...(await analyzer.run(a.applied, [])).indices], [1, 2, 3]);
    assert.deepEqual(a.target('undo'), nested);
    a.move('undo');
    assert.deepEqual([...(await analyzer.run(a.applied, [])).indices], [1, 2]);
    a.move('redo');
    assert.deepEqual(a.applied, second);
    const external = a.applied; external.children.length = 0;
    assert.deepEqual(a.applied, second);
    a.move('undo'); a.commit({ field: 'kind', op: 'eq', value: 'c' });
    assert.equal(a.canRedo, false);
    assert.equal(b.canUndo, false);
    assert.deepEqual(b.applied, { op: 'and', children: [] });
});
test('unchanged applications do not enter history and reload invalidates observation indices in every entry', () => {
    const query = new QueryHistory(nested);
    query.commit(nested); assert.equal(query.canUndo, false);
    query.commit({ op: 'and', children: [nested, { op: 'row', index: 4 }] });
    query.commit({ field: 'kind', op: 'eq', value: 'c' });
    query.discardObservations(); query.move('undo');
    assert.deepEqual(query.applied, { op: 'and', children: [nested] });
    query.move('undo'); assert.deepEqual(query.applied, nested);
});
