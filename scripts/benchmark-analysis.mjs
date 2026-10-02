import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { hash } from '../server/demo.ts';
import { start } from '../server/server.ts';
const n=Number(process.argv[2]??3_000_000),server=start(0);await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?points=${n}&autoload=1`);
  await page.waitForFunction(()=>window.__WFS_MAP__?.metrics.analysisCharts?.length===3,null,{timeout:600000});
  const initial=await page.evaluate(()=>({workerMs:window.__WFS_MAP__.metrics.lastFilterMs,count:window.__WFS_MAP__.metrics.filterCount,charts:window.__WFS_MAP__.metrics.analysisCharts}));
  const expression={op:'and',children:[{op:'or',children:[{field:'category',op:'eq',value:'sensor'},{field:'category',op:'eq',value:'vehicle'}]},{field:'value',op:'gte',value:'50'},{field:'timestamp',op:'gte',value:'2025-01-01T00:00:00Z'}]};
  const samples=[];
  for(let i=0;i<5;i++) {
    const started=performance.now();
    await page.evaluate(e=>{window.__WFS_MAP__.metrics.lastFilterMs=undefined;window.__WFS_MAP__.filter(e);},expression);
    await page.waitForFunction(()=>window.__WFS_MAP__.metrics.lastFilterMs!==undefined);
    samples.push(await page.evaluate(()=>({workerMs:window.__WFS_MAP__.metrics.lastFilterMs,count:window.__WFS_MAP__.metrics.filterCount,charts:window.__WFS_MAP__.metrics.analysisCharts})));
    samples.at(-1).browserRoundTripMs=performance.now()-started;
  }
  const metrics=await page.evaluate(()=>window.__WFS_MAP__.metrics);
  // A fresh all-points request also verifies cached domains and the null index path.
  await page.evaluate(()=>{window.__WFS_MAP__.metrics.lastFilterMs=undefined;window.__WFS_MAP__.filter([]);});
  await page.waitForFunction(()=>window.__WFS_MAP__.metrics.lastFilterMs!==undefined);
  const reset=await page.evaluate(()=>({workerMs:window.__WFS_MAP__.metrics.lastFilterMs,count:window.__WFS_MAP__.metrics.filterCount}));
  await page.screenshot({path:`benchmarks/${n}-analysis-workspace.png`,fullPage:true});
  let expectedCount=0;
  for(let i=0;i<n;i++)if(i%4<2&&Math.round(hash(i+999)*10000)/100>=50&&Date.UTC(2024,0,1)+Math.floor(hash(i+424242)*94694400000)>=Date.UTC(2025,0,1))expectedCount++;
  if(samples.some(s=>s.count!==expectedCount))throw new Error('Filter differs from independent fixture check');
  const result={expectedCount,measuredAt:new Date().toISOString(),features:n,renderer:metrics.renderer,loaded:metrics.loaded,firstPointsMs:metrics.firstPointsMs,loadMs:metrics.elapsedMs,initial,samples,reset,errors,notes:['Worker times include filtering and recomputing all three charts. Initial analysis includes uncached attribute profiles.','Browser round trip includes automation polling and main-thread GPU upload; it is not a frame-time measurement.','SwiftShader software GPU. Hardware-GPU pan/zoom smoothness remains unverified.']};
  await writeFile(`benchmarks/${n}-analysis-workspace.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(errors.length||metrics.loaded!==n||samples.some(s=>s.charts.some(c=>c.plotted+c.missing!==s.count)))throw new Error('Incomplete or inconsistent analysis benchmark');
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
