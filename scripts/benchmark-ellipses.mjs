import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { start } from '../server/server.ts';
const dense=process.argv.includes('--dense');
const points=Number(process.argv[2]??1000000), server=start(0);await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const output={points,distribution:dense?'dense':'uk',measuredAt:new Date().toISOString(),renderer:'',viewport:{width:1440,height:1000},runs:[],errors:[],notes:['Wall-clock render and RAF intervals include software GPU execution. Not hardware-GPU throughput claims.','Each scenario uses the same deterministic million-point WFS fixture and the same camera path. Axes use value/quality fields (0–100 metres), orientation uses id.','Ellipses smaller than 0.75 screen pixels retain their points but skip their outlines. Auto detail thins dense outlines; every-point mode is unthinned. All centre points remain.']};
const q=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*p))]??0;};
try{
 for(const configured of [false,true]){
  const page=await browser.newPage({viewport:output.viewport});page.on('pageerror',e=>output.errors.push(e.message));
  await page.addInitScript(({points,configured,dense})=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'a',name:'Million observations',enabled:true,config:{url:`/wfs?points=${points}&distribution=${dense?'dense':'uk'}`,layer:'demo:points',limit:String(points),...(configured?{ellipseMajorField:'value',ellipseMinorField:'quality',ellipseOrientationField:'id',ellipseMajorUnit:'m',ellipseMinorUnit:'m'}:{})}}],background:{url:'',attribution:'',enabled:false}})),{points,configured,dense});
  await page.goto(`http://127.0.0.1:${server.address().port}/?time=all`);await page.waitForFunction(()=>window.__WFS_MAP__?.done && window.__WFS_MAP__.sources[0].metrics.analysisCharts,null,{timeout:300000});
  output.renderer=await page.evaluate(()=>{const gl=window.__WFS_MAP__.layer.gl,e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'unknown';});
  for(const view of dense?['detail']:['overview','detail']) for(const setting of configured?[{vertices:0,full:false},{vertices:6,full:false},{vertices:12,full:false},...(dense?[{vertices:6,full:true},{vertices:12,full:true}]:[])]:[{vertices:0,full:false}]){
   const {vertices,full}=setting;
   const samples=await page.evaluate(async({view,vertices,dense,full})=>{
    const h=window.__WFS_MAP__,m=h.map,l=h.layer;l.ellipsesEnabled=vertices>0;l.ellipseVertices=vertices||12;l.ellipseFullDetail=full;
    const center=dense?[-1.54,54]:[-3,54],zoom=view==='overview'?5:14;m.jumpTo({center,zoom});
    await new Promise(resolve=>{m.once('render',resolve);m.triggerRepaint();});
    const warmupStart=performance.now();l.gl.finish();const gpuWarmupMs=performance.now()-warmupStart;
    await new Promise(r=>setTimeout(r,250));
    const frames=[],raf=[],calls=[],instances=[],longTasks=[];let last=0,previous=0,running=true;
    const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
    const collect=()=>{const t=performance.now();if(last)frames.push(t-last);last=t;instances.push(l.ellipsesDrawnLastFrame);};
    const tick=t=>{if(!running)return;if(previous)raf.push(t-previous);previous=t;requestAnimationFrame(tick);};
    const original=l.render.bind(l);l.render=(...args)=>{const start=performance.now();original(...args);calls.push(performance.now()-start);};
    m.on('render',collect);requestAnimationFrame(tick);const began=performance.now();
    const d=view==='overview'?.1:.003;
    for(const sign of [1,-1])await new Promise(resolve=>{m.once('moveend',resolve);m.easeTo({center:[center[0]+sign*d,center[1]],zoom:zoom+.15,duration:1500,easing:t=>t});});
    running=false;m.off('render',collect);l.render=original;longTasks.push(...observer.takeRecords().map(e=>e.duration));observer.disconnect();
    return{frames,raf,calls,instances,longTasks,gpuWarmupMs,durationMs:performance.now()-began,gpuBytes:l.gpuBytes,loaded:h.sources[0].loaded,glError:l.gl.getError()};
   },{view,vertices,dense,full});
   if(samples.loaded!==points||samples.glError)throw Error('Incomplete data or WebGL error');
   const result={configured,view,vertices,fullDetail:full,...Object.fromEntries(['durationMs','gpuBytes','loaded','glError','gpuWarmupMs'].map(k=>[k,samples[k]])),frames:samples.frames.length,frameMedianMs:q(samples.frames,.5),frameP95Ms:q(samples.frames,.95),frameMaxMs:Math.max(...samples.frames,0),over33ms:samples.frames.filter(x=>x>33.34).length,rafP95Ms:q(samples.raf,.95),cpuDrawMedianMs:q(samples.calls,.5),cpuDrawP95Ms:q(samples.calls,.95),ellipseInstancesP95:q(samples.instances,.95),longTasks:samples.longTasks};
   output.runs.push(result);console.log(JSON.stringify(result));
  }
  await page.close();
 }
 if(output.errors.length)throw Error(output.errors.join('\n'));
 await writeFile(`benchmarks/ellipses-${points}${dense?'-dense':''}.json`,JSON.stringify(output,null,2)+'\n');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
