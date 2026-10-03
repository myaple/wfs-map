import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=(name:string)=>readFileSync(new URL('../fixtures/public-wfs/'+name,import.meta.url),'utf8');
for(const layerFormats of [true,false])test(`captured Hamburg ${layerFormats?'layer':'global'} formats select GeoJSON and preserve supported manual formats`,async({page})=>{
 await page.route('https://public-wfs.example/**',route=>route.fulfill({contentType:'application/xml',body:layerFormats?fixture('hamburg-capabilities.xml'):fixture('hamburg-capabilities.xml').replace(/<OutputFormats>[\s\S]*?<\/OutputFormats>/g,'')}));
 await page.goto('/?time=all');await page.locator('#configLink').click();await page.locator('#addSource').click();await page.locator('#url').fill('https://public-wfs.example/wfs');await page.locator('#discover').click();
 await expect(page.locator('#discoveryStatus')).toContainText('Output format set to application/geo+json');
 await expect(page.locator('#layer')).toHaveValue('de.hh.up:strassenbaumkataster');
 await page.locator('#wfsCompatibility summary').click();await expect(page.locator('#format')).toHaveValue('application/geo+json');
 await page.locator('#format').fill('application/gml+xml; version=3.2');await page.locator('#discover').click();await expect(page.locator('#discoveryStatus')).toContainText('1 layer(s) found');await expect(page.locator('#format')).toHaveValue('application/gml+xml; version=3.2');
});
for(const city of ['hamburg','berlin'])test(`${city}: captured production schema and GML reach worker, map, charts`,async({page})=>{
 const layer=city==='hamburg'?'de.hh.up:strassenbaumkataster':'baumbestand:strassenbaeume';
 await page.route('**/captured-wfs?*',async route=>{
  const u=new URL(route.request().url());
  if(u.searchParams.get('request')==='DescribeFeatureType')return route.fulfill({contentType:'application/xml',body:fixture(city+'-schema.xsd')});
  if(u.searchParams.get('resultType')==='hits')return route.fulfill({contentType:'application/xml',body:'<FeatureCollection numberMatched="2"/>'});
  // Captured collection metadata describes the full public dataset; make this
  // two-row replay describe the two captured records without altering records.
  const body=fixture(city+'-page.gml').replace(/numberMatched="\d+"/,'numberMatched="2"');
  return route.fulfill({contentType:'application/gml+xml',body});
 });
 await page.addInitScript(({layer})=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'real',name:'Captured public data',enabled:true,config:{url:'/captured-wfs',layer,format:'application/gml+xml; version=3.2',version:'2.0.0',srs:'urn:ogc:def:crs:OGC:1.3:CRS84',axis:'xy',sort:'',pageSize:'2',limit:'2',timeField:'',geometryField:''}}],background:{url:'',attribution:'',enabled:false}})),{layer});
 await page.goto('/?time=all&autoload=1');await page.waitForFunction(()=>(window as any).__WFS_MAP__?.sources[0].metrics.analysisCharts);
 const state=await page.evaluate(()=>{const s=(window as any).__WFS_MAP__.sources[0];return {loaded:s.loaded,error:s.error,fields:s.fields,metrics:s.metrics};});
 expect(state.error).toBe(false);expect(state.loaded).toBe(2);expect(state.fields.find((f:any)=>f.name==='stammumfang'||f.name==='stammumfg')?.kind).toBe('number');
 expect(state.metrics.analysisCharts.every((c:any)=>c.plotted+c.missing===2)).toBe(true);
});

test('WFS 1.0 skips misleading zero hits and pages captured GML2 without losing IDs',async({page})=>{
 const original=fixture('berlin-1.0.0.gml'),members=[...original.matchAll(/<gml:featureMember>[\s\S]*?<\/gml:featureMember>/g)].map(m=>m[0]);
 expect(members).toHaveLength(2);let hits=0;const offsets:string[]=[];
 await page.route('**/legacy-public-wfs?*',async route=>{
  const u=new URL(route.request().url());
  if(u.searchParams.get('request')==='DescribeFeatureType')return route.fulfill({contentType:'application/xml',body:fixture('berlin-schema.xsd')});
  if(u.searchParams.get('resultType')==='hits'){hits++;return route.fulfill({contentType:'application/xml',body:'<FeatureCollection numberOfFeatures="0"/>'});}
  const offset=u.searchParams.get('startIndex')!;offsets.push(offset);
  const body=original.slice(0,original.indexOf('<gml:featureMember>')).replace(/numberOfFeatures="\d+"/,'numberOfFeatures="1"')+members[Number(offset)]+'</wfs:FeatureCollection>';
  return route.fulfill({contentType:'application/xml',body});
 });
 await page.addInitScript(()=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'legacy',name:'Berlin legacy',enabled:true,config:{url:'/legacy-public-wfs',layer:'baumbestand:strassenbaeume',format:'GML2',version:'1.0.0',srs:'urn:ogc:def:crs:OGC:1.3:CRS84',axis:'xy',sort:'',pageSize:'1',limit:'2',timeField:'',geometryField:''}}],background:{url:'',attribution:'',enabled:false}})));
 await page.goto('/?time=all&autoload=1');await page.waitForFunction(()=>(window as any).__WFS_MAP__?.sources[0].metrics.analysisCharts);
 const state=await page.evaluate(()=>{const s=(window as any).__WFS_MAP__.sources[0];return {error:s.error,loaded:s.loaded,pages:s.metrics.pages,warning:s.metrics.warning};});
 expect(state.error).toBe(false);expect(state.loaded).toBe(2);expect(state.pages).toBe(2);expect(hits).toBe(0);expect(offsets).toEqual(['0','1']);expect(state.warning).toContain('no standard hits count');
});
