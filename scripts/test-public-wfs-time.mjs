// Live dated observations: verify FES time + BBOX against independent CQL.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {start} from '../server/server.ts';
import {decodePage,wfsURL} from '../src/data.ts';
const service={url:'https://www.imis.bfs.de/ogc/opendata/ows',layer:'opendata:odlinfo_odl_1h_latest'};
async function query(cql){
 const u=wfsURL(service.url,'2.0.0','GetFeature',{typeNames:service.layer,outputFormat:'application/json',srsName:'urn:ogc:def:crs:OGC:1.3:CRS84',sortBy:'kenn A',count:cql?'250':'2',...(cql?{cql_filter:cql}:{})});
 const r=await fetch(u,{signal:AbortSignal.timeout(60000)});assert.ok(r.ok);return decodePage(await r.text());
}
const sample=await query(),stamp=Date.parse(sample.features[0].properties.end_measure);assert.ok(Number.isFinite(stamp));
const report={checkedAt:new Date().toISOString(),service:'BfS radiation monitoring',endpoint:service.url,layer:service.layer,pass:false,referenceTime:new Date(stamp+3600000).toISOString()};
const server=start(0);await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({proxy:process.env.PUBLIC_WFS_PROXY?{server:process.env.PUBLIC_WFS_PROXY,bypass:'<-loopback>,127.0.0.1,localhost'}:undefined,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000},ignoreHTTPSErrors:process.env.PUBLIC_WFS_IGNORE_HTTPS_ERRORS==='1'});
const requests=[],responses=[],pending=new Set(),errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{const u=new URL(r.url());if(u.origin===new URL(service.url).origin&&u.searchParams.get('request')==='GetFeature')requests.push(u);});
page.on('response',r=>{const u=new URL(r.url());if(u.origin!==new URL(service.url).origin||u.searchParams.get('request')!=='GetFeature'||u.searchParams.get('resultType')==='hits')return;const task=r.text().then(t=>responses.push(decodePage(t))).catch(e=>errors.push(e.message)).finally(()=>pending.delete(task));pending.add(task);});
const flush=async()=>{while(pending.size)await Promise.all([...pending]);};
const ready=()=>page.waitForFunction(()=>{const s=window.__WFS_MAP__?.sources[0];return s&&(s.error||s.done&&s.metrics.analysisCharts);},null,{timeout:120000});
const snapshot=()=>page.evaluate(()=>{const s=window.__WFS_MAP__.sources[0];return {error:s.error,status:s.status,loaded:s.loaded,fields:s.fields,metrics:s.metrics,bounds:window.__WFS_MAP__.queryBounds};});
try{
 await page.clock.setFixedTime(new Date(report.referenceTime));
 await page.addInitScript(service=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'bfs',name:'BfS radiation monitoring',enabled:true,config:{url:service.url,layer:service.layer,version:'2.0.0',format:'application/json',srs:'urn:ogc:def:crs:OGC:1.3:CRS84',axis:'xy',sort:'kenn',pageSize:'100',limit:'250',timeField:'',geometryField:''}}],background:{url:'',attribution:'',enabled:false}})),service);
 await page.goto(`http://127.0.0.1:${server.address().port}/?autoload=1`);await ready();
 assert.equal((await snapshot()).error,true,'Two date fields should require a time override');assert.equal(requests.length,0);
 await page.locator('#configLink').click();await page.getByRole('button',{name:'Configure BfS radiation monitoring',exact:true}).click();await page.locator('#wfsCompatibility summary').click();await page.locator('#timeField').fill('end_measure');await page.locator('#updateSource').click();await page.locator('#saveSettings').click();await ready();await flush();
 report.initial=await snapshot();assert.equal(report.initial.error,false,JSON.stringify(report.initial));assert.equal(report.initial.loaded,250);assert.equal(report.initial.metrics.pages,3);
 const time=report.initial.bounds.time,cql=`end_measure >= '${time.start}' AND end_measure <= '${time.end}'`;
 let expected=await query(cql);assert.deepEqual(responses.flatMap(p=>p.features.map(f=>f.properties.kenn)),expected.features.map(f=>f.properties.kenn));
 assert.ok(requests.every(u=>u.searchParams.get('filter')?.includes('end_measure')));report.timeMatchesIndependentCQL=true;report.comparisonKey='kenn';report.transientWFSFeatureIDs=true;
 for(const f of responses.flatMap(p=>p.features)){const t=Date.parse(f.properties.end_measure);assert.ok(t>=Date.parse(time.start)&&t<=Date.parse(time.end));}
 await page.locator('#analysisLink').click();await page.evaluate(center=>window.__WFS_MAP__.map.jumpTo({center,zoom:14}),sample.features[0].geometry.coordinates);
 const canvas=page.locator('#map canvas');await canvas.scrollIntoViewIfNeeded();const b=await canvas.boundingBox();responses.length=0;requests.length=0;
 await page.mouse.move(b.x+b.width*.3,b.y+b.height*.3);await page.mouse.down({button:'right'});await page.mouse.move(b.x+b.width*.7,b.y+b.height*.7,{steps:4});await page.mouse.up({button:'right'});await ready();await flush();
 report.area=await snapshot();assert.equal(report.area.error,false,JSON.stringify(report.area));const area=report.area.bounds.bbox;
 expected=await query(`${cql} AND BBOX(geom,${area.west},${area.south},${area.east},${area.north},'CRS:84')`);
 assert.deepEqual(responses.flatMap(p=>p.features.map(f=>f.properties.kenn)),expected.features.map(f=>f.properties.kenn));assert.ok(report.area.loaded>0&&report.area.loaded<250);
 assert.ok(requests.every(u=>{const f=u.searchParams.get('filter');return f.includes('<fes:And>')&&f.includes('<fes:BBOX>')&&f.includes('end_measure');}));report.combinedBoundsMatchIndependentCQL=true;
 responses.length=0;await page.getByLabel('Time window',{exact:true}).selectOption('custom');
 const future=new Date(stamp+30*86400000),end=new Date(stamp+31*86400000);await page.getByLabel('Start (UTC)',{exact:true}).fill(future.toISOString().slice(0,16));await page.getByLabel('End (UTC)',{exact:true}).fill(end.toISOString().slice(0,16));await page.getByRole('button',{name:'Apply time range'}).click();await ready();await flush();
 report.empty=await snapshot();assert.equal(report.empty.error,false);assert.equal(report.empty.loaded,0);assert.ok(report.empty.fields.some(f=>f.name==='end_measure'&&f.kind==='date'));
 assert.deepEqual(errors,[]);report.pass=true;console.log(`PASS BfS: 250 dated rows / 3 pages; ${report.area.loaded} in combined time/map bounds; empty future range`);
}catch(e){report.failure=e.message.slice(0,1500);report.errors=errors;console.log('FAIL BfS:',report.failure);process.exitCode=1;}
finally{await browser.close();server.close();await writeFile(new URL('../benchmarks/public-wfs-time.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
