import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page) {
    await page.goto('/?time=all&points=16&autoload=1');
    await page.waitForFunction(() => (window as any).__WFS_MAP__?.workspace.results.length === 3);
    await page.locator('#configLink').click(); await page.locator('#addSource').click();
    await page.locator('#sourceName').fill('Other observations'); await page.locator('#type').selectOption('csv');
    await page.locator('#csvFile').setInputFiles({ name:'other.csv',mimeType:'text/csv',buffer:Buffer.from('lon,lat,day,reading,label\n-1,54,2026-10-01,7,sensor\n-2,53,2026-10-02,9,vehicle\n-3,52,2026-10-03,11,sensor') });
    await expect(page.locator('#csvFileStatus')).toContainText('5 columns'); await page.locator('#csvTime').selectOption('day');
    await page.locator('#updateSource').click(); await page.locator('#saveSettings').click();
    await page.waitForFunction(() => (window as any).__WFS_MAP__.sources[1]?.workspace.results.length === 3);
    await page.locator('#analysisLink').click();
}
async function comparison(page: Page, index: number) {
    const chart = page.locator('.chart-card').nth(index);
    await chart.getByRole('button',{name:'Settings',exact:true}).click();
    await chart.getByRole('button',{name:'+ Add source',exact:true}).click();
    await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    return chart;
}
test('existing bar and pie combine labels, show source legends, reject mixed types and route selections', async ({page}) => {
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await setup(page);const chart=await comparison(page,0);
    await chart.getByLabel('Source 2 X attribute',{exact:true}).selectOption('reading');
    await expect(chart.locator('.hint').last()).toContainText('same attribute type');
    await chart.getByLabel('Source 2 X attribute',{exact:true}).selectOption('label');
    await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    await expect(chart.getByLabel('Chart source legend')).toContainText('WFS source');await expect(chart.getByLabel('Chart source legend')).toContainText('Other observations');
    await chart.getByLabel('Chart type').selectOption('pie');await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    const data=await page.evaluate(()=> (window as any).__WFS_MAP__.sources[0].workspace.results.find((r:any)=>r.type==='pie'));
    expect(data.series).toHaveLength(2);
    await chart.locator('details summary').click();
    await expect(chart.getByRole('button',{name:/category: sensor/})).toContainText('%');
    await chart.getByRole('button',{name:/category: sensor/}).click();
    await page.waitForFunction(()=> (window as any).__WFS_MAP__.sources[1].selected===2);
    await expect(chart.locator('.hint').last()).toContainText('6 plotted');
    expect(await page.evaluate(()=> (window as any).__WFS_MAP__.sources[0].selected)).toBe(4);
    expect(errors).toEqual([]);
});
test('time aggregation and raw scatter share axes; raw inspection selects the correct source', async ({page}) => {
    await setup(page);const time=await comparison(page,1);
    await time.getByLabel('Y aggregation',{exact:true}).selectOption('mean');
    await time.getByLabel('Y attribute',{exact:true}).selectOption('value');
    await time.getByLabel('Source 2 Y attribute',{exact:true}).selectOption('reading');
    await expect(time.locator('.hint').last()).toContainText('19 plotted');
    const timeData=await page.evaluate(()=> (window as any).__WFS_MAP__.sources[0].workspace.results.find((r:any)=>r.type==='time'));
    expect(Object.values(timeData.series[0].result.x.ranges)).toEqual(Object.values(timeData.series[1].result.x.ranges));
    const chart=await comparison(page,2);
    await chart.getByLabel('Source 2 X attribute',{exact:true}).selectOption('reading');
    await chart.getByLabel('Source 2 Y attribute',{exact:true}).selectOption('lat');
    await chart.getByLabel('Binning',{exact:true}).selectOption('exact');
    await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    await chart.getByLabel('Chart selection action').selectOption('inspect');
    const canvas=chart.locator('.raw-scatter canvas:not(.raw-scatter-axes)');
    for(let i=0;i<16;i++) await canvas.press('ArrowRight');
    await canvas.press('Enter');
    await page.locator('#recordsLink').click();
    await expect(page.getByLabel('Record inspector')).toContainText('reading');
    expect(await page.evaluate(()=> (window as any).__WFS_MAP__.sources.map((s:any)=>s.selected))).toEqual([16,3]);
    await page.locator('#analysisLink').click();
    await chart.getByLabel('Chart selection action').selectOption('filter');
    for(let i=0;i<16;i++) await canvas.press('ArrowRight');
    await canvas.press('Enter');
    await page.waitForFunction(()=> (window as any).__WFS_MAP__.sources[1].selected===1);
    expect(await page.evaluate(()=> (window as any).__WFS_MAP__.sources[0].selected)).toBe(16);
    await expect(chart.locator('.hint').last()).toContainText('17 plotted');
});
test('removing a series restores single-source behavior and disabled members clear comparisons', async ({page}) => {
    await setup(page);const chart=await comparison(page,0);
    await page.locator('#configLink').click();await page.getByRole('checkbox',{name:'Enable Other observations',exact:true}).uncheck();await page.locator('#saveSettings').click();await page.locator('#analysisLink').click();
    await expect(chart.locator('.hint').last()).toContainText('Load this source');
    await chart.getByRole('button',{name:'Remove source 2',exact:true}).click();
    await expect(chart.locator('.hint').last()).toContainText('16 plotted');await expect(chart.getByLabel('Chart source legend')).toBeHidden();
});
test('text scatter shares labels on both axes in bins and raw points, including enlarged and narrow views', async ({page}) => {
    await setup(page);const chart=await comparison(page,2);
    await chart.getByLabel('X attribute',{exact:true}).selectOption('category');await chart.getByLabel('Y attribute',{exact:true}).selectOption('category');
    await chart.getByLabel('Source 2 X attribute',{exact:true}).selectOption('label');await chart.getByLabel('Source 2 Y attribute',{exact:true}).selectOption('label');
    await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    await chart.getByLabel('Binning',{exact:true}).selectOption('exact');await expect(chart.locator('.hint').last()).toContainText('19 plotted');
    const raw=await page.evaluate(()=> (window as any).__WFS_MAP__.sources[0].workspace.results.find((r:any)=>r.series&&r.type==='scatter'));
    expect(raw.series[0].result.x.labels).toEqual(raw.series[1].result.x.labels);expect(raw.series[0].result.y.labels).toEqual(raw.series[1].result.y.labels);
    await chart.getByRole('button',{name:'Enlarge',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Chart source legend')).toBeVisible();
    await page.keyboard.press('Escape');await page.setViewportSize({width:375,height:900});
    const fits=await chart.locator('.chart-series-row select').evaluateAll(nodes=>nodes.every(n=>{const a=n.getBoundingClientRect(),b=n.closest('.chart-card')!.getBoundingClientRect();return a.left>=b.left&&a.right<=b.right;}));expect(fits).toBe(true);
    await page.setViewportSize({width:1440,height:900});await chart.screenshot({path:'/tmp/multi-source-chart.png'});
});
