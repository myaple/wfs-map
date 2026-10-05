import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, all } from '../src/analysis.ts';
import { Store } from '../src/store.ts';
import { sharedDomain, combineSeries } from '../src/multi-charts.ts';
import { configurationState } from '../src/analysis-state.ts';
const build = (fields, rows) => { const store = new Store(fields); store.append(rows.map((properties, id) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [0,0] }, properties }))); store.finish(); return new Analyzer(store); };
test('multi-source numeric bins and exact points use one domain with source-local row identities', async () => {
    const a = build([{name:'x',kind:'number'},{name:'y',kind:'number'}], [{x:0,y:2},{x:5,y:4}]);
    const b = build([{name:'v',kind:'number'},{name:'w',kind:'number'}], [{v:5,w:4},{v:10,w:6}]);
    const domains = { x: sharedDomain(await Promise.all([a.domain('x'),b.domain('v')])), y: sharedDomain(await Promise.all([a.domain('y'),b.domain('w')])) };
    for (const binned of [true,false]) {
        const spec = {id:'c',type:'scatter',x:'x',y:'y',bins:8,binned};
        const ar = (await a.run(all([]), [spec], undefined, domains)).charts[0], br = (await b.run(all([]), [{...spec,x:'v',y:'w'}], undefined, domains)).charts[0];
        const r = combineSeries(spec, [{sourceId:'a',name:'A',color:'#2463d4',result:ar},{sourceId:'b',name:'B',color:'#d45b24',result:br}]);
        if (binned) { assert.deepEqual(ar.x.ranges,br.x.ranges); assert.deepEqual(ar.y.ranges,br.y.ranges); assert.equal(r.counts.reduce((a,b)=>a+b),4); }
        else { assert.deepEqual([...r.raw.bounds],[0,2,10,6]); assert.deepEqual([...r.raw.rows],[0,1,0,1]); assert.equal(r.raw.series[1].start,2); assert.deepEqual([...ar.raw.positions.slice(2,4)], [...br.raw.positions.slice(0,2)]); }
    }
    assert.throws(()=>sharedDomain([{kind:'number',min:0,max:1},{kind:'string',min:0,max:1,labels:['1']}]), /same attribute type/);
    assert.throws(()=>sharedDomain([{kind:'date',min:0,max:1},{kind:'number',min:0,max:1}]), /same attribute type/);
});
test('pie counts concatenate unequal sources by common labels and filter each original field exactly', async () => {
    const a = build([{name:'kind',kind:'string'}], [{kind:'red'},{kind:'red'},{kind:'blue'},{kind:null}]);
    const b = build([{name:'label',kind:'string'}], [{label:'blue'},{label:'green'}]);
    const domains = {x: sharedDomain(await Promise.all([a.domain('kind'),b.domain('label')]))};
    const spec = {id:'p',type:'pie',x:'kind',bins:8};
    const ar = (await a.run(all([]),[spec],undefined,domains)).charts[0], br = (await b.run(all([]),[{...spec,x:'label'}],undefined,domains)).charts[0];
    const r = combineSeries(spec,[{sourceId:'a',name:'A',color:'#2463d4',result:ar},{sourceId:'b',name:'B',color:'#d45b24',result:br}]);
    assert.deepEqual(r.x.labels,['blue','green','red','Other categories']); assert.deepEqual([...r.counts],[2,1,2,0]); assert.equal(r.missing,1);
    for (let i=0;i<r.counts.length;i++) assert.equal((await a.run(ar.x.rules[i],[])).count+(await b.run(br.x.rules[i],[])).count,r.counts[i]);
    const filtered = (await a.run({field:'kind',op:'eq',value:'red'},[spec],undefined,domains)).charts[0]; assert.deepEqual([...filtered.counts],[0,0,2,0]);
});
test('multi-source UTC time measures share buckets and specifications save only source mappings', async () => {
    const a = build([{name:'time',kind:'date'},{name:'value',kind:'number'}],[{time:'2026-01-01',value:2}]);
    const b = build([{name:'when',kind:'date'},{name:'reading',kind:'number'}],[{when:'2026-01-02',reading:8}]);
    const domains = {x:sharedDomain(await Promise.all([a.domain('time'),b.domain('when')]))};
    const spec = {id:'t',type:'time',x:'time',y:'value',aggregate:'mean',bins:8,series:[{sourceId:'b',x:'when',y:'reading'}]};
    const ar=(await a.run(all([]),[spec],undefined,domains)).charts[0],br=(await b.run(all([]),[{...spec,x:'when',y:'reading'}],undefined,domains)).charts[0];
    assert.deepEqual(ar.x.ranges,br.x.ranges); assert.equal(ar.values[0],2); assert.equal(br.values[7],8);
    const saved = configurationState({sources:[],background:{url:'',attribution:'',enabled:false}},{choice:'all',bounds:{}},[{id:'a',fields:[],expression:all([]),charts:[{...spec,raw:{rows:[1]}}]}]);
    assert.deepEqual(saved.analyses[0].charts[0].series,spec.series); assert.equal(saved.analyses[0].charts[0].raw,undefined);
});
test('categorical scatter aligns text dictionaries independently on both axes, including raw points and nulls', async () => {
    const a=build([{name:'x',kind:'string'},{name:'y',kind:'string'}],[{x:'b',y:'z'},{x:'a',y:'q'},{x:null,y:'z'}]);
    const b=build([{name:'u',kind:'string'},{name:'v',kind:'string'}],[{u:'a',v:'q'},{u:'c',v:'r'}]);
    const domains={x:sharedDomain(await Promise.all([a.domain('x'),b.domain('u')])),y:sharedDomain(await Promise.all([a.domain('y'),b.domain('v')]))};
    for(const binned of [true,false]) {
        const spec={id:'s',type:'scatter',x:'x',y:'y',bins:8,binned};
        const ar=(await a.run(all([]),[spec],undefined,domains)).charts[0],br=(await b.run(all([]),[{...spec,x:'u',y:'v'}],undefined,domains)).charts[0];
        assert.deepEqual(ar.x.labels,br.x.labels);assert.deepEqual(ar.y.labels,br.y.labels);assert.equal(ar.missing,1);
        if(binned) assert.equal(ar.counts.reduce((n,c)=>n+c),2);
        else { assert.equal(ar.raw.rows.length,2);assert.deepEqual([...ar.raw.positions.slice(2,4)],[...br.raw.positions.slice(0,2)]); }
    }
});

test('shared logarithmic domains align unequal source ranges and fit the union of displayed points', async () => {
    const fields = [{ name: 'x', kind: 'number' }, { name: 'y', kind: 'number' }];
    const a = build(fields, [{ x: -1, y: 0 }, { x: 1, y: 1 }, { x: 10, y: 10 }]);
    const b = build(fields, [{ x: 100, y: 100 }, { x: 1000, y: 1000 }]);
    const domains = { x: sharedDomain(await Promise.all([a.domain('x'), b.domain('x')])), y: sharedDomain(await Promise.all([a.domain('y'), b.domain('y')])) };
    const spec = { id: 'log', type: 'scatter', x: 'x', y: 'y', bins: 8, xScale: 'log10', yScale: 'log10', binned: false };
    const ar = (await a.run(all([]), [spec], undefined, domains)).charts[0], br = (await b.run(all([]), [spec], undefined, domains)).charts[0];
    assert.deepEqual([...ar.raw.bounds], [1, 1, 1000, 1000]); assert.deepEqual(ar.raw.bounds, br.raw.bounds);
    const r = combineSeries(spec, [{ sourceId: 'a', name: 'A', color: '#2463d4', result: ar }, { sourceId: 'b', name: 'B', color: '#d45b24', result: br }]);
    assert.deepEqual([...r.raw.extent], [0, 0, 1, 1]); assert.equal(r.missing, 1); assert.equal(r.raw.rows.length, 4);
});
