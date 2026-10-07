import test from 'node:test';
import assert from 'node:assert/strict';
import { ellipseDefaults, packEllipses, ellipseSamples, EARTH_RADIUS, validateEllipseConfig, validateEllipseVertices } from '../src/ellipses.ts';
import { defaultConfig, validateConfig, validateMapSettings } from '../src/source-settings.ts';
import { configurationState, localSettings } from '../src/analysis-state.ts';
const config = { ...ellipseDefaults, ellipseMajorField:'a', ellipseMinorField:'b', ellipseOrientationField:'angle' };
const feature = (p, lat=54) => ({geometry:{type:'Point',coordinates:[-1,lat]},properties:p});
test('ellipse packing converts each axis independently, wraps orientation, and preserves axes if reversed', () => {
 const nm = packEllipses([feature({a:2,b:1852,angle:-270})],{...config,ellipseMajorUnit:'nm'}).data;
 assert.ok(Math.abs(nm[0]*EARTH_RADIUS-3704)<.001); assert.ok(Math.abs(nm[1]*EARTH_RADIUS-1852)<.001);
 assert.ok(Math.abs(nm[2]-Math.PI/2)<1e-6);
 const reversed = packEllipses([feature({a:'100',b:'200',angle:0})],config).data;
 assert.ok(Math.abs(reversed[0]*EARTH_RADIUS-200)<.001); assert.ok(Math.abs(reversed[2]-Math.PI/2)<1e-6);
 assert.equal(packEllipses([feature({})],ellipseDefaults).data,undefined);
});
test('missing, nonnumeric, empty, nonpositive and infinite axes skip only their ellipse', () => {
 const rows = [{}, {a:1,b:1}, {a:'',b:1,angle:0}, {a:null,b:1,angle:0}, {a:0,b:1,angle:0}, {a:Infinity,b:1,angle:0}, {a:1,b:-1,angle:0}, {a:1,b:1,angle:'no'}, {a:1,b:1,angle:0}].map(p=>feature(p));
 const packed = packEllipses(rows,config); assert.equal(packed.invalid,8); assert.equal(packed.data.length,rows.length*4); assert.ok(packed.data.at(-4)>0);
});
test('curvature weighted sampling concentrates vertices at major-axis tips; circles are uniform and opposite vertices symmetric', () => {
 const p=ellipseSamples(12,8), circle=ellipseSamples(12,1);
 const angle=(v,i)=>Math.atan2(v[i*2+1],v[i*2]);
 assert.ok(angle(p,1)<Math.PI/6); assert.ok(angle(p,3)-angle(p,2)>Math.PI/6);
 for(let i=0;i<12;i++){assert.ok(Math.abs(Math.hypot(p[i*2],p[i*2+1])-1)<1e-6);assert.ok(Math.abs(circle[i*2]-Math.cos(i*Math.PI/6))<1e-6);}
 for(let i=0;i<6;i++) assert.ok(Math.hypot(p[i*2]+p[(i+6)*2],p[i*2+1]+p[(i+6)*2+1])<1e-6);
 assert.equal(ellipseSamples(6,4).length,12);
});
test('ellipse settings are optional, validate partial mappings and survive metadata-only save/restore', () => {
 globalThis.location={href:'http://localhost/'};
 validateEllipseConfig(ellipseDefaults); assert.throws(()=>validateEllipseConfig({...config,ellipseMinorField:''}),/three/);
 assert.throws(()=>validateEllipseConfig({...config,ellipseMajorUnit:'feet'}),/units/);
 for(const n of [3,129,NaN,6.5]) assert.throws(()=>validateEllipseVertices(n),/vertices/);
 for(const n of [4,6,12,128]) validateEllipseVertices(n);
 const settings={sources:[{id:'a',name:'A',enabled:true,config:{...defaultConfig,...config,url:'/wfs',layer:'a'}}],background:{url:'',attribution:'',enabled:false},map:{center:[-1,54],zoom:10,pointSize:2,ellipses:true,ellipseVertices:6,ellipseFullDetail:true}};
 validateConfig(settings.sources[0].config); validateMapSettings(settings.map);
 const state=configurationState(settings,{choice:'all',bounds:{}},[]), restored=localSettings(state);
 assert.deepEqual(restored.map,settings.map); assert.equal(restored.sources[0].config.ellipseMajorField,'a'); assert.equal(Object.hasOwn(state.settings.sources[0].config,'csvText'),false);
});
