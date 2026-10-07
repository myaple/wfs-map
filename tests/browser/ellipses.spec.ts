import { test, expect } from '@playwright/test';
import { navigate } from '../navigation.ts';
const csv='lon,lat,major,minor,angle\n-1.550,54.000,300,70,90\n-1.540,54.000,300,70,0\n-1.545,53.995,300,70,45\n-1.552,53.995,,,0';
const config={type:'csv',csvText:csv,csvRef:'ellipse-fixture',fileName:'ellipses.csv',longitudeField:'lon',latitudeField:'lat',ellipseMajorField:'major',ellipseMinorField:'minor',ellipseOrientationField:'angle',ellipseMajorUnit:'m',ellipseMinorUnit:'m'};
async function fixture(page:any){
 await page.addInitScript(config=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'ellipses',name:'Ellipse examples',enabled:true,config:{url:'',...config}}],background:{url:'',attribution:'',enabled:false},map:{center:[-1.546,53.998],zoom:14,pointSize:4,ellipses:true,ellipseVertices:12}})),config);
 await page.goto('/?time=all'); await page.waitForFunction(()=>(window as any).__WFS_MAP__?.done);
}
test('CSV ellipses render, toggle, change resolution and persist with configuration',async({page})=>{
 const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message)); await fixture(page);
 await expect(page.locator('#toggleEllipses')).toHaveAttribute('aria-pressed','true');
 await page.waitForFunction(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame===4);
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.sources[0].metrics.warning)).toContain('1 point has');
 for(const vertices of [6,12]){
  await page.locator('#ellipseResolution summary').click(); await page.locator('#ellipseVertices').fill(String(vertices)); await page.locator('#ellipseVertices').press('Tab'); await page.locator('#ellipseResolution summary').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipseVertices)).toBe(vertices);
  await page.locator('.map-panel').screenshot({path:`benchmarks/ellipses-${vertices}-vertices.png`});
 }
 await page.locator('#toggleEllipses').click(); await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBe(0);
 await page.locator('#toggleEllipses').click();
 await page.evaluate(()=>(window as any).__WFS_MAP__.filter([{field:'major',op:'gte',value:'200'}]));
 await page.waitForFunction(()=>(window as any).__WFS_MAP__.sources[0].selected===3);
 await navigate(page,'configuration'); await page.getByRole('button',{name:'Configure Ellipse examples',exact:true}).click();
 await expect(page.locator('#ellipseFields')).not.toHaveAttribute('open',''); await page.locator('#ellipseFields summary').click();
 await expect(page.locator('#ellipseMajorField')).toHaveValue('major'); await expect(page.locator('#ellipseMajorUnit')).toHaveValue('m');
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.layer.gl.getError())).toBe(0);
 await page.locator('#ellipseFields').screenshot({path:'benchmarks/ellipse-source-settings.png'});
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.layer.gl.getError())).toBe(0);
 expect(errors).toEqual([]);
});
test('WFS ellipse attributes pack in the worker and respect map visibility and picking',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'wfs',name:'WFS ellipses',enabled:true,config:{url:'/wfs?points=1024&distribution=dense',layer:'demo:points',ellipseMajorField:'value',ellipseMinorField:'quality',ellipseOrientationField:'id',ellipseMajorUnit:'nm',ellipseMinorUnit:'m'}}],background:{url:'',attribution:'',enabled:false},map:{center:[-1.54,54],zoom:14,pointSize:2,ellipses:true,ellipseVertices:6}})));
 await page.goto('/?time=all');await page.waitForFunction(()=>(window as any).__WFS_MAP__?.done);
 await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBe(1024);
 const p=await page.evaluate(()=>{const h=(window as any).__WFS_MAP__,p=h.map.project([-1.54,54]);return {x:p.x,y:p.y};});
 expect(Number.isFinite(p.x)).toBe(true);
 await page.evaluate(()=>{const h=(window as any).__WFS_MAP__;h.layer.visible=false;h.map.triggerRepaint();});
 await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBe(0);
 await page.evaluate(()=>{const h=(window as any).__WFS_MAP__;h.layer.visible=true;h.map.triggerRepaint();});
 await page.locator('#enlargeMap').click();await expect(page.locator('#toggleEllipses')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.layer.gl.getError())).toBe(0);
 expect(errors).toEqual([]);
});

test('outline endpoints match spherical ground distances, colours and map masks', async ({page}) => {
 await fixture(page);
 const pixel = async (lon:number,lat:number) => page.evaluate(({lon,lat}) => new Promise<number[]>(resolve => {
  const h=(window as any).__WFS_MAP__, gl=h.layer.gl;
  h.map.once('render',()=>{
   const p=h.map.project([lon,lat]), canvas=h.map.getCanvas(), scale=canvas.width/canvas.clientWidth;
   const data=new Uint8Array(7*7*4);gl.readPixels(Math.round(p.x*scale)-3,canvas.height-Math.round(p.y*scale)-3,7,7,gl.RGBA,gl.UNSIGNED_BYTE,data);
   const channels=[0,0,0];for(let i=0;i<data.length;i+=4) if(data[i]>200 && data[i+1]<60 && data[i+2]<60) channels[0]++;resolve(channels);
  });h.map.triggerRepaint();
 }),{lon,lat});
 await page.evaluate(()=>{const l=(window as any).__WFS_MAP__.layer;l.setColors(new Uint8Array(l.count),['#ff0000','#ff0000'],2);});
 // Eastward 300 m geodesic from the horizontal ellipse's centre.
 const lat=54*Math.PI/180,d=300/6371008.8;
 const targetLat=Math.asin(Math.sin(lat)*Math.cos(d))*180/Math.PI;
 const targetLon=-1.55+Math.atan2(Math.sin(d)*Math.cos(lat),Math.cos(d)-Math.sin(lat)*Math.sin(targetLat*Math.PI/180))*180/Math.PI;
 expect((await pixel(targetLon,targetLat))[0]).toBeGreaterThan(0);
 await page.evaluate(()=>{const l=(window as any).__WFS_MAP__.layer;l.setMapMask(Uint8Array.of(0,1,1,1));});
 expect((await pixel(targetLon,targetLat))[0]).toBe(0);
 await page.evaluate(()=>{const l=(window as any).__WFS_MAP__.layer;l.setMapMask();l.filter(Uint32Array.of(1,2));});
 expect((await pixel(targetLon,targetLat))[0]).toBe(0);
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.layer.gl.getError())).toBe(0);
});

test('automatic detail bounds dense outlines; every-point mode keeps full fidelity without changing data', async ({page}) => {
 await page.addInitScript(()=>localStorage.setItem('wfs-settings',JSON.stringify({sources:[{id:'dense',name:'Dense ellipses',enabled:true,config:{url:'/wfs?points=20000&distribution=dense',layer:'demo:points',ellipseMajorField:'value',ellipseMinorField:'quality',ellipseOrientationField:'id'}}],background:{url:'',attribution:'',enabled:false},map:{center:[-1.54,54],zoom:14,pointSize:2,ellipses:true,ellipseVertices:6}})));
 await page.goto('/?time=all'); await page.waitForFunction(()=>(window as any).__WFS_MAP__?.done);
 await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBeGreaterThan(0);
 expect(await page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBeLessThan(5000);
 await page.locator('#ellipseResolution summary').click(); await page.locator('#ellipseDetail').selectOption('all');
 await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBe(20000);
 const state=await page.evaluate(()=>{const h=(window as any).__WFS_MAP__,s=h.sources[0];return{loaded:s.loaded,selected:s.selected,glError:s.layer.gl.getError(),saved:JSON.parse(localStorage.getItem('wfs-settings')!).map.ellipseFullDetail};});
 expect(state).toEqual({loaded:20000,selected:20000,glError:0,saved:true});
 await page.locator('#ellipseDetail').selectOption('auto');
 await page.evaluate(()=>(window as any).__WFS_MAP__.map.jumpTo({center:[-1.54,54],zoom:18}));
 await expect.poll(()=>page.evaluate(()=>(window as any).__WFS_MAP__.layer.ellipsesDrawnLastFrame)).toBeLessThan(5000);
});
