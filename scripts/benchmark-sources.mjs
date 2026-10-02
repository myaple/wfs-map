import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { start } from '../server/server.ts';
import { hash } from '../server/demo.ts';
const n=Number(process.argv[2]??1500000),server=start(0);await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));const began=performance.now();
 const config={url:'/wfs',layer:'demo:points',points:String(n),distribution:'uk',version:'2.0.0',format:'application/json',srs:'urn:ogc:def:crs:OGC:1.3:CRS84',axis:'xy',sort:'',pageSize:'50000',limit:String(n)};
 await page.addInitScript(({config})=>localStorage.setItem('wfs-sources',JSON.stringify([{id:'first',name:'UK observations',enabled:true,config},{id:'second',name:'World observations',enabled:true,config:{...config,distribution:'world'}}])),{config});
 await page.goto(`http://127.0.0.1:${server.address().port}/?time=all&autoload=1`);await page.waitForFunction(()=>window.__WFS_MAP__?.sources.every(s=>s.done&&s.metrics.analysisCharts?.length===3),null,{timeout:600000});const allReadyMs=performance.now()-began;
 const selections=[[{field:'category',op:'eq',value:'sensor'},{field:'value',op:'gte',value:'50'}],[{field:'category',op:'eq',value:'vehicle'},{field:'quality',op:'gte',value:'80'}]];
 const started=performance.now();await page.evaluate(selections=>{const h=window.__WFS_MAP__;h.sources.forEach((s,i)=>{s.metrics.lastFilterMs=undefined;s.workspace.select({op:'and',children:selections[i]},i===0?'category = sensor AND value ≥ 50':'category = vehicle AND quality ≥ 80');});},selections);await page.waitForFunction(()=>window.__WFS_MAP__.sources.every(s=>s.metrics.lastFilterMs!==undefined));
 const sources=await page.evaluate(()=>window.__WFS_MAP__.sources.map(s=>({name:s.name,loaded:s.loaded,selected:s.selected,workerMs:s.metrics.lastFilterMs,charts:s.metrics.analysisCharts,gpuBytes:s.layer.gpuBytes,loadMs:s.metrics.elapsedMs}))),selectionResponseMs=performance.now()-started;
 let expectedFirst=0,expectedSecond=0;for(let i=0;i<n;i++){if(i%4===0&&Math.round(hash(i+999)*10000)/100>=50)expectedFirst++;if(i%4===1&&Math.round(hash(i+88)*100)>=80)expectedSecond++;}
 const result={measuredAt:new Date().toISOString(),featuresPerSource:n,totalLoaded:n*2,allReadyMs,selectionResponseMs,sources,selections,independentExpected:[expectedFirst,expectedSecond],errors,note:'Two simultaneous sources, separate workers, independent filters and three charts each. Software GPU; responses include automation and GPU upload; they do not wait for map paint or establish smoothness.'};
 if(errors.length||sources.some((s,i)=>s.loaded!==n||s.selected!==result.independentExpected[i]||s.charts.some(c=>c.plotted+c.missing!==s.selected)))throw Error('Multi-source benchmark failed');
 await page.screenshot({path:`benchmarks/${n*2}-multi-source.png`,fullPage:true});await writeFile(`benchmarks/${n*2}-multi-source.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
