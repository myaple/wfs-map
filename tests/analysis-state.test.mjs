import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationState, localSettings, shareExpression, emptyState } from '../src/analysis-state.ts';
import { defaultConfig } from '../src/source-settings.ts';
test('remote workspace serialization contains configuration and no CSV bytes or runtime results', () => {
    const source={id:'csv',name:'Stations',enabled:true,config:{...defaultConfig,type:'csv',csvText:'lon,lat,secret\n1,2,SENSITIVE_ROW',csvRef:'file-id',longitudeField:'lon',latitudeField:'lat'},features:['SENSITIVE_ROW'],metrics:{secret:'SENSITIVE_ROW'}};
    const fields=[{name:'lon',kind:'number'},{name:'lat',kind:'number'}];
    const expression={op:'and',children:[{field:'lon',op:'gte',value:'0'}]};
    const chart={id:'chart',type:'scatter',x:'lon',y:'lat',bins:24,binned:false,results:['SENSITIVE_ROW']};
    const state=configurationState({sources:[source],background:{url:'',attribution:'',enabled:false}},{choice:'all',bounds:{}},[{id:'csv',fields,expression,charts:[chart],rows:['SENSITIVE_ROW']}]);
    const json=JSON.stringify(state);
    assert(!json.includes('SENSITIVE_ROW')); assert(!json.includes('csvText')); assert(!json.includes('features')); assert(!json.includes('results'));assert(!json.includes('rows'));
    assert.deepEqual(state.analyses[0].expression,expression);
    assert.equal(localSettings(state).sources[0].config.csvText,'');
    assert.equal(localSettings(state).sources[0].config.csvRef,'file-id');
    assert.equal(emptyState().settings.sources.length,0);
});
test('row-index selections are cleared as a whole instead of silently changing group semantics',()=>{
    const e={op:'or',children:[{field:'category',op:'eq',value:'A'},{op:'row',index:4}]};
    assert.deepEqual(shareExpression(e),{op:'and',children:[]});
});
