import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationState, localSettings, shareExpression, emptyState } from '../src/analysis-state.ts';
import { defaultConfig } from '../src/source-settings.ts';
test('remote workspace serialization contains configuration and no CSV bytes or runtime results', () => {
    const source={id:'csv',name:'Stations',enabled:true,config:{...defaultConfig,type:'csv',csvText:'lon,lat,secret\n1,2,SENSITIVE_ROW',csvRef:'file-id',longitudeField:'lon',latitudeField:'lat'},coloring:{field:'lon',bins:8,low:'#112233',high:'#445566',scale:'log10'},features:['SENSITIVE_ROW'],metrics:{secret:'SENSITIVE_ROW'}};
    const fields=[{name:'lon',kind:'number'},{name:'lat',kind:'number'}];
    const expression={op:'and',children:[{field:'lon',op:'gte',value:'0'}]};
    const chart={id:'chart',type:'scatter',x:'lon',y:'lat',bins:24,pointSize:5,hiddenSources:['csv'],binned:false,xScale:'log10',yScale:'linear',results:['SENSITIVE_ROW']};
    const state=configurationState({sources:[source],background:{url:'',attribution:'',enabled:false}},{choice:'all',bounds:{}},[{id:'csv',fields,expression,charts:[chart],rows:['SENSITIVE_ROW']}]);
    const json=JSON.stringify(state);
    assert(!json.includes('SENSITIVE_ROW')); assert(!json.includes('csvText')); assert(!json.includes('features')); assert(!json.includes('results'));assert(!json.includes('rows'));
    assert.deepEqual(state.analyses[0].expression,expression);
    assert.equal(state.settings.sources[0].coloring.scale,'log10');
    assert.equal(state.analyses[0].charts[0].pointSize,5); assert.deepEqual(state.analyses[0].charts[0].hiddenSources,['csv']);
    assert.equal(state.analyses[0].charts[0].xScale,'log10'); assert.equal(state.analyses[0].charts[0].yScale,'linear');
    assert.equal(localSettings(state).sources[0].config.csvText,'');
    assert.equal(localSettings(state).sources[0].config.csvRef,'file-id');
    assert.equal(emptyState().settings.sources.length,0);
});
test('saving row-index selections fails explicitly and preserves every live predicate',()=>{
    for (const op of ['and', 'or']) {
        const e={op,children:[{field:'category',op:'eq',value:'A'},{op:'or',children:[{op:'row',index:4}]}]};
        const before=structuredClone(e);
        assert.throws(()=>shareExpression(e),/Individual-observation selections cannot be saved/);
        assert.deepEqual(e,before);
        assert.throws(()=>configurationState(emptyState().settings,emptyState().query,[{id:'csv',fields:[],expression:e,charts:[]}]),/Remove those selection chips/);
    }
});
test('portable nested filters round-trip with their exact group semantics',()=>{
    const e={op:'and',children:[{field:'category',op:'eq',value:'A'},{op:'or',children:[{field:'value',op:'gte',value:'8'},{op:'bbox',west:-5,east:1,south:50,north:55}]}]};
    const saved=shareExpression(e);
    assert.deepEqual(saved,e);
    saved.children.pop();
    assert.equal(e.children.length,2);
});
