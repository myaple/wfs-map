import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Analyzer, all } from '../src/analysis.ts';
import { TimelineIndex, timeField, moveWindow, resizeWindow } from '../src/timeline-data.ts';

function dataset(kind = 'date') {
    const store = new Store([{name:'when',kind},{name:'label',kind:'string'},{name:'value',kind:'number'}]);
    const times = ['2026-10-01T00:00:00Z','2026-10-01T01:00:00+01:00','2026-10-02 00:00:00.001','2026-10-03',null,kind==='string'?'bad':null];
    const rows = times.map((when,i)=>({id:i,geometry:{type:'Point',coordinates:[i,54]},properties:{when,label:i%2?'b':'a',value:i}}));
    store.append(rows.slice(0,3)); store.append(rows.slice(3)); store.finish();
    return store;
}
test('timeline decodes UTC once across chunks and resolves configured/namespaced fields safely', () => {
    for (const kind of ['date','string']) {
        const store=dataset(kind), index=new TimelineIndex(store,'when');
        assert.deepEqual(index.extent,{field:'when',start:Date.parse('2026-10-01'),end:Date.parse('2026-10-03'),valid:4,missing:2});
        assert.equal(index.values[0][0],index.values[0][1]);
        if(kind==='date')assert.equal(index.values[0],store.chunks[0].values[0]);
        const analyzer=new Analyzer(store);assert.equal(analyzer.timeline('when'),analyzer.timeline('when'));
    }
    assert.equal(timeField([{name:'when',kind:'date'}],'demo:when'),'when');
    assert.equal(timeField([{name:'when',kind:'date'},{name:'other',kind:'date'}]),'');
    assert.equal(timeField([{name:'when',kind:'date'}],'missing'),'');
});
test('inclusive timeline composes with OR/AND filters and drives all chart types and exact points', async () => {
    for(const kind of ['date','string']) {
        const analyzer=new Analyzer(dataset(kind));
        const expression={op:'or',children:[{field:'label',op:'eq',value:'a'},{field:'value',op:'eq',value:'1'}]};
        const specs=[{id:'bar',type:'bar',x:'label',bins:8},{id:'pie',type:'pie',x:'label',bins:8},{id:'scatter',type:'scatter',x:'value',y:'value',bins:8,binned:false}];
        if(kind==='date')specs.push({id:'time',type:'time',x:'when',bins:8,aggregate:'sum',y:'value'});
        const window={field:'when',start:Date.parse('2026-10-01'),end:Date.parse('2026-10-02')+1};
        const selected=await analyzer.run(expression,specs,()=>false,undefined,window);
        assert.deepEqual([...selected.indices],[0,1,2]);assert.equal(selected.count,3);
        for(const chart of selected.charts)assert.equal(chart.raw?.rows.length??chart.counts.reduce((n,c)=>n+c,0),3);
        const instant=await analyzer.run(all([]),[],()=>false,undefined,{...window,end:window.start});
        assert.deepEqual([...instant.indices],[0,1]);
        const changed=await analyzer.run({field:'label',op:'eq',value:'b'},[],()=>false,undefined,window);
        assert.deepEqual([...changed.indices],[1]);
        assert.deepEqual([...(await analyzer.run(expression,[],()=>false,undefined,window)).indices],[0,1,2]);
        const empty=await analyzer.run(all([]),[],()=>false,undefined,{...window,start:window.end+1,end:window.end+2});
        assert.equal(empty.count,0);assert.equal(empty.indices.length,0);
        assert.equal((await analyzer.run(all([]),[])).count,6);
        assert.equal((await analyzer.run(all([]),[])).indices,null);
        await assert.rejects(analyzer.run(all([]),[],()=>false,undefined,{...window,start:NaN}),/Invalid timeline/);
    }
});
test('moving preserves duration at extent boundaries and resize supports empty/instant windows',()=>{
    const extent={start:0,end:100},window={start:20,end:40};
    assert.deepEqual(moveWindow(window,extent,-100),{start:0,end:20});
    assert.deepEqual(moveWindow(window,extent,100),{start:80,end:100});
    assert.deepEqual(resizeWindow(window,extent,'start',80),{start:40,end:40});
    assert.deepEqual(resizeWindow(window,extent,'end',-20),{start:20,end:20});
    assert.deepEqual(resizeWindow(window,extent,'start',-30),{start:0,end:40});
});
