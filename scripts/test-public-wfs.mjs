// Opt-in integration test: makes small, bounded requests to actual public WFS.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {start} from '../server/server.ts';
import {decodePage,wfsURL} from '../src/data.ts';
const services=[
 {name:'Hamburg street trees',url:'https://geodienste.hamburg.de/HH_WFS_Strassenbaumkataster',layer:'de.hh.up:strassenbaumkataster',sort:'baumid',format:'application/geo+json',center:[9.846289,53.525474]},
 {name:'Berlin street trees',url:'https://gdi.berlin.de/services/wfs/baumbestand',layer:'baumbestand:strassenbaeume',sort:'gisid',format:'application/json',center:[13.44828415,52.44315194]}
];
const server=start(0);await new Promise(resolve=>server.once('listening',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({proxy:process.env.PUBLIC_WFS_PROXY?{server:process.env.PUBLIC_WFS_PROXY,bypass:'<-loopback>,127.0.0.1,localhost'}:undefined,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const report={checkedAt:new Date().toISOString(),requestsAreLive:true,rendering:'Chromium SwiftShader',transport:{proxy:!!process.env.PUBLIC_WFS_PROXY,ignoreHTTPSErrors:process.env.PUBLIC_WFS_IGNORE_HTTPS_ERRORS==='1'},cases:[]};
async function independent(service,version,params){
 const url=wfsURL(service.url,version,'GetFeature',{[version==='2.0.0'?'typeNames':'typeName']:service.layer,srsName:'urn:ogc:def:crs:OGC:1.3:CRS84',outputFormat:service.format,sortBy:service.sort+' A',...params});
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)});assert.ok(r.ok,`Independent query HTTP ${r.status}`);return decodePage(await r.text());
}
const ready=page=>page.waitForFunction(()=>{const s=window.__WFS_MAP__?.sources[0];return s&&(s.error||s.done&&s.metrics.analysisCharts);},null,{timeout:120000});
async function check(service,version,format){
 const page=await browser.newPage({viewport:{width:1440,height:1000},ignoreHTTPSErrors:report.transport.ignoreHTTPSErrors});
 const result={service:service.name,endpoint:service.url,layer:service.layer,version,format,pass:false};report.cases.push(result);
 const errors=[],responses=[],pending=new Set();
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{
  const u=new URL(r.url());if(u.origin!==new URL(service.url).origin||u.searchParams.get('request')!=='GetFeature'||u.searchParams.get('resultType')==='hits')return;
  const task=r.text().then(text=>responses.push({url:r.url(),status:r.status(),page:decodePage(text)})).catch(e=>errors.push(e.message)).finally(()=>pending.delete(task));pending.add(task);
 });
 const flush=async()=>{while(pending.size)await Promise.all([...pending]);};
 const snapshot=()=>page.evaluate(()=>{const s=window.__WFS_MAP__.sources[0];return {loaded:s.loaded,error:s.error,status:s.status,fields:s.fields,metrics:s.metrics};});
 try{
  await page.goto(origin+'/?time=all');await page.locator('#configLink').click();await page.locator('#addSource').click();await page.locator('#sourceName').fill(service.name);await page.locator('#url').fill(service.url);
  await page.locator('#wfsCompatibility summary').click();await page.locator('#version').selectOption(version);
  await page.locator('#discover').click();await page.waitForFunction(()=>!document.querySelector('#discover').disabled);
  if(!(await page.locator('#discoveryStatus').textContent()).includes('layer(s) found')){await page.locator('#discover').click();await page.waitForFunction(()=>!document.querySelector('#discover').disabled);}
  result.discovery=await page.locator('#discoveryStatus').textContent();
  assert.match(result.discovery,/layer\(s\) found/,'Capabilities discovery failed');
  await page.locator('#layer').fill(service.layer);
  if(format==='auto')assert.equal(await page.locator('#format').inputValue(),service.format);else await page.locator('#format').fill(format);
  await page.locator('#sort').fill(service.sort);await page.locator('#pageSize').fill('100');await page.locator('#limit').fill('250');await page.locator('#updateSource').click();await page.locator('#saveSettings').click();await ready(page);await flush();
  result.initial=await snapshot();assert.equal(result.initial.error,false,JSON.stringify(result.initial));assert.equal(result.initial.loaded,250);assert.equal(result.initial.metrics.pages,3);assert.equal(result.initial.metrics.truncated,true);
  assert.ok(result.initial.metrics.analysisCharts.every(c=>c.plotted+c.missing===250),'Chart totals lose observations');
  const expected=await independent(service,version,{[version==='2.0.0'?'count':'maxFeatures']:'250',startIndex:'0'});
  const actual=responses.flatMap(r=>r.page.features);
  assert.deepEqual(actual.map(f=>f.id),expected.features.map(f=>f.id),'Paging differs from independent single-page response');
  result.pagingMatchesIndependentQuery=true;
  await page.locator('#analysisLink').click();await page.waitForFunction(()=>window.__WFS_MAP__.layer.drawnLastFrame>0);
  // Ordinary chart filters must operate locally, using actual server values.
  const prop=Object.entries(actual[0].properties).find(([k,v])=>typeof v==='string'&&v&&v.length<80&&result.initial.fields.some(f=>f.name===k&&f.kind==='string'));
  if(prop){
   const before=responses.length,expectedCount=actual.filter(f=>String(f.properties[prop[0]])===String(prop[1])).length;
   await page.evaluate(([field,value])=>window.__WFS_MAP__.filter([{field,op:'eq',value:String(value)}]),prop);
   await page.waitForFunction(n=>window.__WFS_MAP__.metrics.filterCount===n,expectedCount);
   await flush();assert.equal(responses.length,before);result.localFilter={field:prop[0],matched:expectedCount,noServerRequests:true};await page.locator('#reset').click();
  }
  // A time bound on a timeless schema must fail before any GetFeature request.
  const beforeTime=responses.length;await page.getByLabel('Time window',{exact:true}).selectOption('24');await page.waitForFunction(()=>window.__WFS_MAP__.sources[0].error);await flush();assert.equal(responses.length,beforeTime);result.timelessSourceRejectsTimeBounds=true;
  await page.getByLabel('Time window',{exact:true}).selectOption('all');await ready(page);await flush();
  // Exercise the real right-button gesture, then compare XML FILTER against
  // an independently expressed KVP BBOX, without reusing the app's XML builder.
  await page.evaluate(center=>window.__WFS_MAP__.map.jumpTo({center,zoom:18}),service.center);
  const canvas=page.locator('#map canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();responses.length=0;
  await page.mouse.move(box.x+box.width*.35,box.y+box.height*.35);await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width*.65,box.y+box.height*.65,{steps:4});await page.mouse.up({button:'right'});
  await ready(page);await flush();const bounds=await page.evaluate(()=>window.__WFS_MAP__.queryBounds.bbox);assert.ok(bounds,'No map area created');
  result.area=await snapshot();assert.equal(result.area.error,false,JSON.stringify(result.area));
  const bbox=await independent(service,version,{[version==='2.0.0'?'count':'maxFeatures']:'250',startIndex:'0',bbox:`${bounds.west},${bounds.south},${bounds.east},${bounds.north},urn:ogc:def:crs:OGC:1.3:CRS84`});
  const bounded=responses.flatMap(r=>r.page.features);
  assert.deepEqual(bounded.map(f=>f.id),bbox.features.map(f=>f.id),'XML BBOX differs from independent KVP BBOX');
  assert.equal(result.area.loaded,bbox.features.length);assert.ok(result.area.loaded>0&&result.area.loaded<250,'Area should be small and complete');
  result.outsideGeographicBox=bounded.filter(f=>{const [x,y]=f.geometry.coordinates;return !(x>=bounds.west-1e-6&&x<=bounds.east+1e-6&&y>=bounds.south-1e-6&&y<=bounds.north+1e-6);}).map(f=>({id:f.id,coordinates:f.geometry.coordinates}));
  // Native projected-CRS BBOX envelopes can include points just outside
  // the geographic rectangle. The independent server query is authoritative.
  result.nativeCRSEnvelopeBroadening=result.outsideGeographicBox.length;
  result.bboxMatchesIndependentQuery=true;result.bbox=bounds;
  await page.locator('#clearArea').click();await ready(page);assert.equal((await snapshot()).loaded,250);
  assert.deepEqual(errors,[]);result.pass=true;
  console.log(`PASS ${service.name} ${version} ${format}: 250 rows / 3 pages; ${result.area.loaded} in map area`);
 }catch(e){result.failure=e.message;result.errors=errors;console.log(`FAIL ${service.name} ${version} ${format}: ${e.message}`);}
 finally{await page.close();await writeFile(new URL('../benchmarks/public-wfs.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
}
try{
 for(const service of services)for(const format of ['auto','application/gml+xml; version=3.2'])await check(service,'2.0.0',format);
 await check(services[1],'1.1.0','application/json');
 await check(services[1],'1.1.0','text/xml; subtype=gml/3.1.1');
 await check(services[1],'1.0.0','GML2');
}finally{await browser.close();server.close();await mkdir(new URL('../benchmarks/',import.meta.url),{recursive:true});await writeFile(new URL('../benchmarks/public-wfs.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
if(report.cases.some(c=>!c.pass))process.exitCode=1;
