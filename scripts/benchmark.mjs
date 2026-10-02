import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { start } from '../server/server.ts';
const n=Number(process.argv[2]??3_000_000);
const server=process.env.BENCHMARK_URL?null:start(0);
if(server)await once(server,'listening');
const url=process.env.BENCHMARK_URL??`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${url}/?time=all&points=${n}&autoload=1`);
  await page.waitForFunction(()=>window.__WFS_MAP__?.done,null,{timeout:600000});
  await page.evaluate(()=>window.__WFS_MAP__.filter([{field:'category',op:'eq',value:'sensor'},{field:'value',op:'gte',value:'50'},{field:'timestamp',op:'gte',value:'2025-01-01T00:00:00Z'}]));
  await page.waitForFunction(()=>window.__WFS_MAP__.metrics.lastFilterMs!==undefined);
  const filtered=await page.evaluate(()=>({milliseconds:window.__WFS_MAP__.metrics.lastFilterMs,matches:window.__WFS_MAP__.metrics.filterCount}));
  await page.evaluate(()=>window.__WFS_MAP__.filter([]));
  await page.waitForFunction(()=>window.__WFS_MAP__.layer.indices===null);
  await page.evaluate(()=>window.__WFS_MAP__.benchmark());
  await mkdir('benchmarks',{recursive:true});
  await page.screenshot({path:`benchmarks/${n}-software-gpu.png`});
  const metrics=await page.evaluate(()=>window.__WFS_MAP__.metrics);metrics.multiAttributeFilter=filtered;metrics.browserErrors=errors;
  await writeFile(`benchmarks/${n}-software-gpu.json`,JSON.stringify(metrics,null,2));
  console.log(JSON.stringify(metrics,null,2));
  if(errors.length||metrics.loaded!==n)throw new Error('Benchmark incomplete or browser errors');
}finally{await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
