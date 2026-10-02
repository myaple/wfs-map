import {chromium} from '@playwright/test';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {start} from '../server/server.ts';
import {feature} from '../server/demo.ts';
const n=Number(process.argv[2]??3000000),date=process.argv[3]==='date',prefix=`${n}-${date?'date-':''}controls`,server=start(0);await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/?points=${n}&autoload=1`);await page.waitForFunction(()=>window.__WFS_MAP__?.workspace.results.length===3,null,{timeout:600000});
 for(const toggle of await page.getByRole('button',{name:'Settings',exact:true}).all())await toggle.click();
 const initial=await page.evaluate(()=>({loaded:window.__WFS_MAP__.metrics.loaded,loadMs:window.__WFS_MAP__.metrics.elapsedMs,workerMs:window.__WFS_MAP__.metrics.lastFilterMs}));
 await page.getByLabel('Point colour attribute').selectOption('value');await page.waitForFunction(n=>window.__WFS_MAP__.layer.colorCodes?.length===n,n,{timeout:600000});
 await page.locator('.chart-card').nth(1).getByLabel('Y aggregation').selectOption('mean');await page.locator('.chart-card').nth(1).getByLabel('Y attribute').selectOption('quality');
 const raw=page.locator('.chart-card').nth(2);if(date)await raw.getByLabel('X attribute').selectOption('timestamp');await raw.getByLabel('Binning',{exact:true}).selectOption('exact');await page.waitForFunction(n=>window.__WFS_MAP__.workspace.results[2].raw?.rows.length===n,n,{timeout:600000});
 const unbinned=await page.evaluate(()=>{const h=window.__WFS_MAP__,r=h.workspace.results[2];return{workerMs:h.metrics.lastFilterMs,observations:r.raw.rows.length,positionsBytes:r.raw.positions.byteLength,idsBytes:r.raw.rows.byteLength,colorBytes:h.layer.colorCodes.byteLength,gpuBytes:h.layer.gpuBytes};});
 const geo={op:'bbox',west:-5,east:0,south:52,north:56};let expected=0;for(let i=0;i<n;i++){const [x,y]=feature(i).geometry.coordinates;if(x>=geo.west&&x<=geo.east&&y>=geo.south&&y<=geo.north)expected++;}
 const began=performance.now();await page.evaluate(e=>{const h=window.__WFS_MAP__;h.metrics.lastFilterMs=undefined;h.workspace.select(e,'UK geographic selection');},geo);await page.waitForFunction(()=>window.__WFS_MAP__.metrics.lastFilterMs!==undefined,null,{timeout:600000});
 const selected=await page.evaluate(()=>{const h=window.__WFS_MAP__,r=h.workspace.results[2];return{count:h.metrics.filterCount,observations:r.raw.rows.length,workerMs:h.metrics.lastFilterMs,colorBytes:h.layer.colorCodes.byteLength};});selected.responseMs=performance.now()-began;
 if(initial.loaded!==n||selected.count!==expected||selected.observations!==expected||unbinned.observations!==n||errors.length)throw Error('Benchmark counts or browser errors failed');
 await page.screenshot({path:`benchmarks/${prefix}.png`,fullPage:true});
 const result={measuredAt:new Date().toISOString(),features:n,initial,unbinned,geo,expected,selected,errors,notes:['All observations drawn with WebGL, no sampling; coordinates and IDs are transferred typed buffers.','Software GPU (ANGLE SwiftShader). Worker time excludes GPU rendering; browser response includes automation and uploads, without waiting for map paint.','Numeric color codes occupy one byte per loaded point, remain fixed through geographic filtering.']};
 await writeFile(`benchmarks/${prefix}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
