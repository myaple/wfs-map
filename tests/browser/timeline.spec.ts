import { navigate, openFilters, openTimeline } from '../navigation.ts';
import { test, expect, type Page } from '@playwright/test';
import { defaultConfig } from '../../src/source-settings.ts';
import { feature } from '../../server/demo.ts';
import { readFile } from 'node:fs/promises';
import { parseCSV } from '../../src/csv.ts';
test.setTimeout(30_000);

async function ready(page: Page) {
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.sources.filter((s: any) => s.enabled).every((s: any) => s.done && !s.filtering && !s.timelinePending));
}
async function range(page: Page, start: string, end: string) {
    await openTimeline(page);
    await page.getByLabel('Timeline start (UTC)', {exact:true}).fill(start);
    await page.getByLabel('Timeline end (UTC)', {exact:true}).fill(end);
    await page.getByRole('button', {name:'Set window',exact:true}).click();
    await expect(page.getByLabel('Use time window')).toBeChecked();
}
async function selected(page: Page) {
    return page.evaluate(() => (window as any).__WFS_MAP__.sources.filter((s:any)=>s.enabled).map((s:any)=>s.selected));
}
async function seed(page: Page) {
    await page.addInitScript(config => localStorage.setItem('wfs-settings',JSON.stringify({sources:[
        {id:'wfs',name:'WFS',enabled:true,config:{...config,url:'/wfs?points=4096',layer:'demo:points'}},
        {id:'csv',name:'CSV',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',timeField:'day',csvText:'lon,lat,day,label,value\n-1,54,2025-01-01,a,1\n-2,53,2025-01-02,b,2\n-3,52,2025-01-03,a,3\n-4,51,,a,4'}},
        {id:'untimed',name:'Untimed',enabled:true,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',csvText:'lon,lat,label\n-1,54,a'}},
        {id:'disabled',name:'Disabled',enabled:false,config:{...config,type:'csv',longitudeField:'lon',latitudeField:'lat',timeField:'day',csvText:'lon,lat,day\n-1,54,2040-01-01'}}
    ]})),defaultConfig);
    await page.goto('/?time=all#analysis'); await ready(page);
    await openTimeline(page);
    await expect(page.locator('.timeline-status')).toContainText('2 timed sources');
}

test('timeline composes applied filters across WFS/CSV, updates charts and exports, and never refetches',async({page})=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await seed(page);
    await expect(page.locator('.timeline-status')).toContainText('1 missing/invalid');
    await expect(page.locator('.timeline-status')).toContainText('Untimed');
    expect(await selected(page)).toEqual([4096,4,1]);
    let requests=0;page.on('request',r=>{if(/GetFeature|DescribeFeatureType/i.test(r.url()))requests++;});
    await page.evaluate(()=>(window as any).__WFS_MAP__.filterSource('wfs',{op:'or',children:[{field:'category',op:'eq',value:'sensor'},{field:'category',op:'eq',value:'vehicle'}]}));
    await ready(page);
    // Leave an unapplied editor draft: scrubbing must retain the applied OR predicate.
    await openFilters(page);
    await page.locator('#rules > .filter-group > .group-head').getByRole('button',{name:'+ Rule',exact:true}).click();
    await page.locator('#rules .rule').last().getByLabel('Attribute',{exact:true}).selectOption('category');
    await page.locator('#rules .rule').last().getByLabel('Filter value',{exact:true}).fill('absent');
    await range(page,'2025-01-01','2025-01-02');
    const expected=Array.from({length:4096},(_,i)=>feature(i)).filter(f=>['sensor','vehicle'].includes(f.properties.category)&&Date.parse(f.properties.timestamp)>=Date.parse('2025-01-01')&&Date.parse(f.properties.timestamp)<=Date.parse('2025-01-02')).length;
    await expect.poll(()=>selected(page)).toEqual([expected,2,1]);await ready(page);
    const counts=await page.evaluate(()=>(window as any).__WFS_MAP__.sources.slice(0,2).map((s:any)=>s.workspace.results.map((c:any)=>c.counts.reduce((n:number,k:number)=>n+k,0)+c.missing)));
    expect(counts[0].every((n:number)=>n===expected)).toBe(true);expect(counts[1].every((n:number)=>n===2)).toBe(true);
    await page.locator('#exportSource').selectOption('csv');
    const pending=page.waitForEvent('download');await page.locator('#exportCSV').click();const file=await pending;
    expect(parseCSV(await readFile((await file.path())!,'utf8')).rows).toHaveLength(2);
    await range(page,'2025-01-02','2025-01-02');await expect.poll(()=>selected(page)).toEqual([0,1,1]);
    await page.getByRole('button',{name:'Show all loaded times',exact:true}).click();
    await expect.poll(()=>selected(page)).toEqual([2048,4,1]);
    await expect(page.locator('.timeline-axis')).not.toContainText('2040');
    expect(requests).toBe(0);expect(errors).toEqual([]);
});

test('resize and move with pointer and keyboard; timeline stays usable at the bottom of enlarged map and chart',async({page})=>{
    await seed(page);
    await range(page,'2025-01-01','2025-03-01');await ready(page);
    const before=await page.evaluate(()=>(window as any).__WFS_MAP__.map.getCenter().toArray());
    await page.locator('#enlargeMap').click();
    const dialog=page.getByRole('dialog',{name:'Enlarged map',exact:true});
    await expect(dialog.locator('.timeline')).toBeVisible();
    const bottom=(await dialog.locator('.timeline').boundingBox())!,map=(await page.locator('#map').boundingBox())!;
    expect(bottom.y).toBeGreaterThanOrEqual(map.y+map.height-1);
    expect(bottom.y+bottom.height).toBeLessThanOrEqual(900);
    const start=page.getByRole('slider',{name:'Timeline start handle',exact:true});
    const oldStart=Number(await start.getAttribute('aria-valuenow'));
    await start.focus();await page.keyboard.press('ArrowRight');
    await expect.poll(async()=>Number(await start.getAttribute('aria-valuenow'))).toBeGreaterThan(oldStart);
    const move=page.getByRole('slider',{name:'Move time window',exact:true});
    await move.focus();await page.keyboard.press('Home');
    const duration=Number(await page.getByRole('slider',{name:'Timeline end handle',exact:true}).getAttribute('aria-valuenow'))-Number(await start.getAttribute('aria-valuenow'));
    await page.keyboard.press('End');
    expect(Number(await page.getByRole('slider',{name:'Timeline end handle',exact:true}).getAttribute('aria-valuenow'))-Number(await start.getAttribute('aria-valuenow'))).toBe(duration);
    const handle=page.getByRole('slider',{name:'Timeline end handle',exact:true}),box=(await handle.boundingBox())!;
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x-100,box.y+box.height/2,{steps:20});await page.mouse.up();await ready(page);
    expect(Number(await handle.getAttribute('aria-valuenow'))-Number(await start.getAttribute('aria-valuenow'))).toBeLessThan(duration);
    await page.keyboard.press('Escape');await expect(page.locator('#app > .timeline')).toBeVisible();
    expect(await page.evaluate(()=>(window as any).__WFS_MAP__.map.getCenter().toArray())).toEqual(before);
    await page.locator('.chart-card').first().getByRole('button',{name:'Enlarge',exact:true}).click();
    await expect(page.locator('.chart-dialog > .timeline')).toBeVisible();
    await page.setViewportSize({width:375,height:700});
    expect(await page.locator('.chart-dialog > .timeline').evaluate(e=>{const r=e.getBoundingClientRect();return r.bottom<=innerHeight&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth;})).toBe(true);
    await page.getByRole('button',{name:'Show all loaded times',exact:true}).click();await expect.poll(()=>selected(page)).toEqual([4096,4,1]);
    await page.keyboard.press('Escape');await expect(page.locator('#app > .timeline')).toBeVisible();
});

test('multi-source chart shares the timeline; rapid drag settles on the latest window without a request backlog',async({page})=>{
    await seed(page);
    const chart=page.locator('.chart-card[data-source-id=wfs]').first();await chart.getByRole('button',{name:'Settings',exact:true}).click();
    await chart.getByRole('button',{name:'+ Add source',exact:true}).click();
    await chart.getByLabel('Source 2',{exact:true}).selectOption('csv');
    await chart.getByLabel('Source 2 X attribute',{exact:true}).selectOption('label');
    await expect(chart.locator('.hint').last()).toContainText('4,100 plotted');
    await range(page,'2025-01-01','2025-01-03');await expect(chart.locator('.hint').last()).toContainText('plotted');
    const track=page.locator('.timeline-track');await track.scrollIntoViewIfNeeded();
    const box=(await page.getByRole('slider',{name:'Move time window',exact:true}).boundingBox())!;
    await ready(page);
    const countBefore=await page.evaluate(()=>{
        const api=(window as any).__WFS_MAP__,worker=api.sources[0].worker as Worker;
        const pending=new Set<number>();let maximum=0;
        const send=worker.postMessage.bind(worker);
        worker.postMessage=(message:any,options?:any)=>{if(message.type==='analyze'){pending.add(message.request);maximum=Math.max(maximum,pending.size);}send(message,options);};
        // Observe completion before the app starts its one deferred latest request.
        const receive=worker.onmessage;
        worker.onmessage=event=>{if(['filtered','filterError'].includes(event.data.type))pending.delete(event.data.request);receive?.call(worker,event);};
        api.timelineQueue=()=>({maximum,pending:pending.size});
        return api.sources[0].filterRequest;
    });
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+240,box.y+box.height/2,{steps:80});await page.mouse.up();await ready(page);
    const result=await page.evaluate(()=>{const api=(window as any).__WFS_MAP__,h=document.querySelector('[data-edge=start]')!,e=document.querySelector('[data-edge=end]')!;return {start:Number(h.getAttribute('aria-valuenow')),end:Number(e.getAttribute('aria-valuenow')),selected:api.sources.slice(0,2).map((s:any)=>s.selected),request:api.sources[0].filterRequest,queue:api.timelineQueue()};});
    const expected=Array.from({length:4096},(_,i)=>feature(i)).filter(f=>{const t=Date.parse(f.properties.timestamp);return t>=result.start&&t<=result.end;}).length;
    expect(result.selected[0]).toBe(expected);
    // Pointer down plus 80 moves may all finish on a fast worker without coalescing.
    expect(result.request-countBefore).toBeLessThanOrEqual(81);
    expect(result.queue.maximum).toBeLessThanOrEqual(1);expect(result.queue.pending).toBe(0);
    await expect(chart.locator('.hint').last()).toContainText(`${(result.selected[0]+result.selected[1]).toLocaleString()} plotted`);
    await openTimeline(page);
    await page.getByLabel('Timeline start (UTC)',{exact:true}).fill('invalid');await page.getByRole('button',{name:'Set window',exact:true}).click();
    await expect(page.locator('.timeline-error')).toBeVisible();expect(await selected(page)).toEqual([...result.selected,1]);
});

test('timeline is unavailable for untimed/empty sources and resets when data is cleared',async({page})=>{
    await page.goto('/#analysis');await expect(page.getByLabel('Use time window')).toBeDisabled();
    await page.goto('/?time=all&points=32&autoload=1');await ready(page);
    await openTimeline(page);
    await page.getByLabel('Use time window').check();await expect(page.getByLabel('Use time window')).toBeChecked();
    await page.locator('#cancel').click();await expect(page.getByLabel('Use time window')).toBeDisabled();await expect(page.getByLabel('Use time window')).not.toBeChecked();
});

test('an enlarged timeline returns to Records when the page changes behind its dialog', async ({ page }) => {
    await seed(page);
    await range(page, '2025-01-01', '2025-01-03'); await ready(page);
    await page.locator('#enlargeMap').click();
    await expect(page.locator('.map-dialog > .timeline')).toBeVisible();
    await page.evaluate(() => { location.hash = '#records'; });
    await expect(page.locator('.map-dialog > .timeline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#app > .timeline')).toBeVisible();
    await expect(page.getByLabel('Use time window')).toBeChecked();
    await navigate(page, 'analysis');
    await expect(page.locator('#app > .timeline')).toBeVisible();
    await expect(page.locator('.timeline')).toHaveCount(1);
});
