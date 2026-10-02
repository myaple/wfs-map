import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { PointsLayer } from './points-layer.ts';
import { wfsURL, fieldKind, xmlDocument, type Field, type Rule } from './data.ts';
import './style.css';
maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const value=(id:string)=>$<HTMLInputElement>(id).value;
const params=new URLSearchParams(location.search);
$('app').innerHTML=`<aside>
  <h1>Million-point WFS map</h1><p class="hint">Every loaded point in a GPU layer. Double-click a point for metadata. No hover inspection.</p>
  <label for="url">WFS endpoint</label><input id="url" value="/wfs">
  <div class="row"><button id="discover">Discover layers</button><select id="layer" aria-label="Feature type"><option>demo:points</option></select></div>
  <label for="points">Generated dataset size (development WFS only)</label><input id="points" type="number" min="1" max="50000000" value="3000000">
  <label for="distribution">Generated distribution</label><select id="distribution"><option value="uk">UK spread</option><option value="world">Worldwide</option><option value="dense">Dense 2 km square</option></select>
  <details><summary>WFS compatibility and limits</summary>
    <label for="version">WFS version</label><select id="version"><option>2.0.0</option><option>1.1.0</option><option>1.0.0</option></select>
    <label for="format">Output format (as advertised by your server)</label><input id="format" value="application/json">
    <label for="srs">Requested coordinate reference system</label><input id="srs" value="urn:ogc:def:crs:OGC:1.3:CRS84">
    <label for="axis">GML coordinate order (GeoJSON is always lon/lat)</label><select id="axis"><option value="xy">Longitude, latitude</option><option value="yx">Latitude, longitude</option></select>
    <label for="sort">Stable unique sort attribute (optional)</label><input id="sort" placeholder="e.g. id">
    <label for="pageSize">Features per request</label><input id="pageSize" type="number" value="50000" min="1" max="100000">
    <label for="limit">Client point limit (truncation is reported)</label><input id="limit" type="number" value="10000000" min="1" max="50000000">
    <p class="hint">Requires paging and GeoJSON or simple GML Point output. Use a stable server snapshot. CORS must permit this page's origin. WFS 1.x paging is a server extension.</p>
  </details>
  <div class="row"><button id="load" class="primary">Load all points</button><button id="cancel" disabled>Cancel / clear</button></div>
  <progress id="progress" max="1" value="0"></progress><div id="status" role="status">Ready. Default development dataset: 3 million points.</div>
  <h2>Attribute filters</h2><p class="hint">All rules are combined with AND. Times use ISO 8601; text comparisons are case sensitive. Filters apply to the complete loaded dataset.</p>
  <div id="rules"></div><button id="addRule" disabled>+ Add rule</button>
  <div class="row"><button id="apply" disabled>Apply filters</button><button id="reset" disabled>Reset</button></div>
  <div id="filterStatus" class="hint"></div>
  <h2>Display and measurement</h2>
  <label for="size">Point diameter (CSS pixels)</label><input id="size" type="range" min="1" max="8" step="0.5" value="2">
  <div class="row"><button id="fit" disabled>Fit dataset</button><button id="benchmark" disabled>Run pan / zoom test</button></div>
  <label><input id="basemap" type="checkbox" style="width:auto"> Online OpenStreetMap basemap</label>
  <button id="export">Download metrics</button><p class="hint">Default grid basemap works offline. Pan test reports frame intervals, not GPU timing. Smoothness depends on GPU, viewport and point density.</p>
</aside><main id="map"><div id="hud">Starting map…</div></main>`;
if(params.has('points'))$<HTMLInputElement>('points').value=params.get('points')!;
if(params.has('distribution'))$<HTMLSelectElement>('distribution').value=params.get('distribution')!;
if(params.has('url'))$<HTMLInputElement>('url').value=params.get('url')!;
const gridFeatures:any[]=[];
for(let x=-180;x<=180;x+=10)gridFeatures.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[[x,-85],[x,85]]}});
for(let y=-80;y<=80;y+=10)gridFeatures.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[[-180,y],[180,y]]}});
const style:StyleSpecification={version:8,sources:{grid:{type:'geojson',data:{type:'FeatureCollection',features:gridFeatures}},osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors',maxzoom:19}},layers:[{id:'background',type:'background',paint:{'background-color':'#e8eff3'}},{id:'osm',type:'raster',source:'osm',layout:{visibility:'none'}},{id:'grid',type:'line',source:'grid',paint:{'line-color':'#b5c7d1','line-width':.5}}]};
const map=new maplibregl.Map({container:'map',style,center:[-3,54],zoom:5,maxZoom:22,minZoom:1,maxPitch:0,dragRotate:false,pitchWithRotate:false,touchPitch:false,renderWorldCopies:false,pixelRatio:Math.min(devicePixelRatio,2),canvasContextAttributes:{antialias:false},attributionControl:{compact:true}});
map.touchZoomRotate.disableRotation();map.keyboard.disableRotation();map.doubleClickZoom.disable();map.addControl(new maplibregl.NavigationControl({showCompass:false}));
let layer=new PointsLayer(), worker:Worker|undefined, fields:Field[]=[], schemaHints:Field[]=[];
let loaded=0,total:number|undefined,selected=0,loading=false,done=false,request=0,filterRequest=0,popup:maplibregl.Popup|undefined;
let metrics:Record<string,any>={};let benchmarkRunning=false;
function status(text:string,error=false) {$('status').textContent=text;$('status').classList.toggle('error',error);}
function enabled(id:string,on:boolean) {$<HTMLButtonElement>(id).disabled=!on;}
function state() {enabled('load',!loading);enabled('discover',!loading);enabled('cancel',loading||loaded>0);for(const id of ['addRule','apply','reset','benchmark','fit'])enabled(id,done&&loaded>0);}
function endpoint() {
  const u=new URL(value('url'),location.href);
  if(u.origin===location.origin && u.pathname==='/wfs') {u.searchParams.set('points',value('points'));u.searchParams.set('distribution',value('distribution'));}
  return u.href;
}
async function discover() {
  enabled('discover',false);schemaHints=[];
  try {
    const response=await fetch(wfsURL(endpoint(),value('version'),'GetCapabilities'));
    const text=await response.text();xmlDocument(text);
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const doc=new DOMParser().parseFromString(text,'text/xml');
    const types=[...doc.getElementsByTagNameNS('*','FeatureType')].map(el=>el.getElementsByTagNameNS('*','Name')[0]?.textContent??'').filter(Boolean);
    if(!types.length)throw new Error('No feature types in GetCapabilities');
    $('layer').replaceChildren(...types.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
    status(`Discovered ${types.length} layer(s). Select a layer, then load.`);
  }catch(e){status((e as Error).message,true);}finally{state();}
}
async function describe():Promise<Field[]> {
  try {
    const r=await fetch(wfsURL(endpoint(),value('version'),'DescribeFeatureType',{[value('version')==='2.0.0'?'typeNames':'typeName']:value('layer')}));
    const text=await r.text();xmlDocument(text);
    if(!r.ok)return [];
    const doc=new DOMParser().parseFromString(text,'text/xml');
    const elements=[...doc.getElementsByTagNameNS('*','sequence')].flatMap(seq=>[...seq.children]).filter(el=>el.localName==='element');
    return elements.filter(el=>el.hasAttribute('name')&&!/gml:|geometry|point|polygon|curve|surface/i.test(el.getAttribute('type')??'')).map(el=>({name:el.getAttribute('name')!,kind:fieldKind(el.getAttribute('type')??'string')}));
  }catch{return [];}
}
function clear() {
  request++;filterRequest++;worker?.terminate();worker=undefined;popup?.remove();
  if(map.getLayer(layer.id))map.removeLayer(layer.id);
  layer=new PointsLayer();layer.pointSize=Number(value('size'));map.addLayer(layer);
  loaded=0;selected=0;loading=false;done=false;fields=[];metrics={};$('rules').replaceChildren();$('filterStatus').textContent='';
  $<HTMLProgressElement>('progress').value=0;state();
}
async function load() {
  clear();loading=true;state();status('Reading feature schema…');
  const session=request;
  schemaHints=await describe();if(session!==request)return;
  worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
  const began=performance.now();
  metrics={startedAt:new Date().toISOString(),userAgent:navigator.userAgent,pointsRequested:Number(value('points')),viewport:{width:map.getCanvas().width,height:map.getCanvas().height},devicePixelRatio,pointSize:layer.pointSize,distribution:value('distribution'),renderer:gpuName(),note:'Actual browser frame intervals; no GPU timer queries. JSON bytes are uncompressed.'};
  worker.onerror=e=>{loading=false;done=false;status(e.message,true);state();};
  worker.onmessage=e=>{
    if(session!==request)return;const m=e.data;
    try {
      if(m.type==='init') {total=m.total;layer.allocate(m.capacity);status('Fetching paged WFS features… '+(m.warning??''));}
      if(m.type==='fields')fields=m.fields;
      if(m.type==='chunk') {layer.append(m.offset,m.positions,m.indices,m.groups);if(!metrics.firstPointsMs)metrics.firstPointsMs=performance.now()-began;}
      if(m.type==='progress'||m.type==='done') {
        loaded=m.loaded;selected=loaded;total=m.total;metrics={...metrics,...m};delete metrics.type;
        const progress=$<HTMLProgressElement>('progress');if(total!==undefined&&total>0)progress.value=loaded/total;else progress.removeAttribute('value');
        status(`${loaded.toLocaleString()}${total!==undefined?' / '+total.toLocaleString():''} points · ${m.pages} pages · ${(m.elapsedMs/1000).toFixed(1)} s`);
      }
      if(m.type==='done') {loading=false;done=true;metrics.readyMs=performance.now()-began;metrics.gpuBytes=layer.gpuBytes;state();if(m.bounds)fit();status(`${loaded.toLocaleString()} points loaded in ${(m.elapsedMs/1000).toFixed(1)} s.${m.truncated?' LIMIT REACHED: dataset is incomplete.':''}${m.warning?'\n'+m.warning:''}`);}
      if(m.type==='error') {loading=false;done=false;worker?.terminate();status('Load failed: '+m.message+'\nPartial points are visible; filters are disabled. Clear and retry.',true);state();}
      if(m.type==='filtered'&&m.request===filterRequest) {layer.filter(m.indices);selected=m.count;metrics.lastFilterMs=m.elapsedMs;metrics.filterCount=m.count;metrics.gpuBytes=layer.gpuBytes;$('filterStatus').textContent=`${selected.toLocaleString()} matches · ${m.elapsedMs.toFixed(0)} ms`;}
      if(m.type==='filterError'&&m.request===filterRequest)$('filterStatus').textContent='Filter error: '+m.message;
      if(m.type==='metadata'&&m.request===request&&m.data)showMetadata(m.data);
    }catch(error){loading=false;done=false;worker?.terminate();status((error as Error).message,true);state();}
  };
  worker.postMessage({type:'load',config:{url:endpoint(),version:value('version'),typeName:value('layer'),format:value('format'),srs:value('srs'),axis:value('axis'),pageSize:Number(value('pageSize')),limit:Number(value('limit')),sort:value('sort'),fields:schemaHints}});
}
function fit() {const b=metrics.bounds;if(b?.length===4&&b.every(Number.isFinite))map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:35,duration:0});}
function addRule() {
  const row=document.createElement('div');row.className='rule';
  const field=document.createElement('select');field.setAttribute('aria-label','Attribute');
  for(const f of fields){const o=document.createElement('option');o.value=f.name;o.textContent=`${f.name} (${f.kind})`;field.append(o);}
  const op=document.createElement('select');op.setAttribute('aria-label','Operator');
  for(const [v,t] of [['eq','='],['ne','≠'],['gte','≥'],['lte','≤'],['gt','>'],['lt','<'],['contains','contains'],['null','is null'],['notnull','not null']]){const o=document.createElement('option');o.value=v;o.textContent=t;op.append(o);}
  const input=document.createElement('input');input.placeholder='Value (true / false for booleans)';input.setAttribute('aria-label','Filter value');
  const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','Remove rule');remove.onclick=()=>row.remove();
  op.onchange=()=>{input.disabled=op.value==='null'||op.value==='notnull';};
  row.append(field,op,remove,input);$('rules').append(row);
}
function filter(rules?:Rule[]) {
  if(!done)return;
  rules??=[...$('rules').children].map(row=>({field:(row.children[0] as HTMLSelectElement).value,op:(row.children[1] as HTMLSelectElement).value as Rule['op'],value:(row.children[3] as HTMLInputElement).value}));
  $('filterStatus').textContent='Filtering…';popup?.remove();worker?.postMessage({type:'filter',request:++filterRequest,rules});
}
function showMetadata(data:any) {
  popup?.remove();const div=document.createElement('div');div.className='metadata';const table=document.createElement('table');
  for(const [k,v] of Object.entries({featureId:data.id,longitude:data.coordinates[0],latitude:data.coordinates[1],...data.properties})) {
    const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');th.textContent=k;td.textContent=v===null?'null':typeof v==='object'?JSON.stringify(v):String(v);tr.append(th,td);table.append(tr);
  }
  div.append(table);popup=new maplibregl.Popup({maxWidth:'380px'}).setLngLat(data.coordinates).setDOMContent(div).addTo(map);
}
map.on('dblclick',e=>{e.preventDefault();if(!loaded)return;const start=performance.now(),index=layer.pick(e.point.x,e.point.y);metrics.lastPickMs=performance.now()-start;if(index!==null)worker?.postMessage({type:'get',index,request});});
map.on('webglcontextlost',()=>status('GPU context lost; waiting for restoration.',true));
map.on('webglcontextrestored',()=>{if(!map.getLayer(layer.id))map.addLayer(layer);status(`GPU context restored; ${loaded.toLocaleString()} points retained.`);});
map.on('error',e=>status(e.error.message,true));
function gpuName() {const gl=map.getCanvas().getContext('webgl2');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unavailable';}
const intervals:number[]=[];let lastRender=0,lastHud=0;
map.on('render',()=>{const t=performance.now();if(map.isMoving()&&lastRender){const dt=t-lastRender;if(dt<1000)intervals.push(dt);if(intervals.length>300)intervals.shift();}lastRender=t;if(t-lastHud>250){hud();lastHud=t;}});
function quantile(values:number[],q:number) {if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))];}
function hud() {$('hud').textContent=`Loaded ${loaded.toLocaleString()} · displayed ${selected.toLocaleString()}\nGPU buffers ${(layer.gpuBytes/1048576).toFixed(1)} MiB\nMoving frame interval: median ${quantile(intervals,.5).toFixed(1)} ms · p95 ${quantile(intervals,.95).toFixed(1)} ms\nZoom ${map.getZoom().toFixed(2)} · point diameter ${layer.pointSize} px`;}
setInterval(hud,1000);
async function benchmark() {
  if(benchmarkRunning)return;benchmarkRunning=true;enabled('benchmark',false);fit();await new Promise(r=>setTimeout(r,200));
  const start=map.getCenter(), zoom=map.getZoom(),frames:number[]=[],raf:number[]=[];let prev=0,rafPrev=0,active=true;
  const collect=()=>{const t=performance.now();if(prev)frames.push(t-prev);prev=t;};
  const tick=(t:number)=>{if(!active)return;if(rafPrev)raf.push(t-rafPrev);rafPrev=t;requestAnimationFrame(tick);};
  const began=performance.now();map.on('render',collect);requestAnimationFrame(tick);
  for(const [dx,dy,dz] of [[.2,.1,.5],[-.2,-.1,1],[0,0,0]])await new Promise<void>(resolve=>{map.once('moveend',()=>resolve());map.easeTo({center:[start.lng+dx,start.lat+dy],zoom:zoom+dz,duration:2000,easing:t=>t});});
  active=false;map.off('render',collect);
  metrics.panZoom={nominalDurationMs:6000,actualDurationMs:performance.now()-began,mapFrames:frames.length,frameMedianMs:quantile(frames,.5),frameP95Ms:quantile(frames,.95),frameMaxMs:Math.max(...frames,0),over33ms:frames.filter(x=>x>33.34).length,rafMedianMs:quantile(raf,.5),rafP95Ms:quantile(raf,.95),pointSize:layer.pointSize,selected,renderer:gpuName()};
  benchmarkRunning=false;state();status(`Pan / zoom: median ${metrics.panZoom.frameMedianMs.toFixed(1)} ms · p95 ${metrics.panZoom.frameP95Ms.toFixed(1)} ms · ${frames.length} frames in 6 s. Export metrics for details.`);
  return metrics.panZoom;
}
$('discover').onclick=()=>void discover();$('load').onclick=()=>void load();$('cancel').onclick=()=>{clear();status('Cleared.');};$('addRule').onclick=addRule;$('apply').onclick=()=>filter();$('reset').onclick=()=>{$('rules').replaceChildren();filter([]);};$('fit').onclick=fit;$('benchmark').onclick=()=>void benchmark();
$('size').oninput=()=>{layer.pointSize=Number(value('size'));map.triggerRepaint();};
$<HTMLInputElement>('basemap').onchange=()=>{map.setLayoutProperty('osm','visibility',$<HTMLInputElement>('basemap').checked?'visible':'none');};
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(metrics,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='wfs-map-metrics.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
// Small explicit harness for repeatable browser measurements; no per-frame feature queries.
(window as any).__WFS_MAP__={map,get layer(){return layer;},get metrics(){return metrics;},get done(){return done;},load,filter,benchmark,getPoint:(index:number)=>worker?.postMessage({type:'get',index,request})};
map.on('load',()=>{map.addLayer(layer);state();if(params.get('autoload')==='1')void load();});
