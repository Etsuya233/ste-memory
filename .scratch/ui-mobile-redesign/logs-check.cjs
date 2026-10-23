const {chromium}=require('C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const go=async()=>{await page.goto('http://127.0.0.1:8799/?tab=logs');await page.locator('[data-action="toggle-log-detail"]').first().waitFor();};
 try {
  for(const width of [360,390,430,1280]) for(const theme of ['dark','light']) {
   await page.setViewportSize({width,height:width===430?420:844});await go();
   await page.locator('#stm-panel').evaluate((el,theme)=>{el.dataset.theme=theme;el.dataset.size='large'},theme);
   assert.equal(await page.locator('[data-action="toggle-log-detail"]').count(),32);
   assert.equal(await page.locator('.stm-log-tab details').getAttribute('open'),null);
   const over=await page.locator('.stm-page-content').evaluate(el=>el.scrollWidth-el.clientWidth);assert.ok(over<=1,`${width} ${theme} overflow ${over}`);
   await page.locator('[data-action="toggle-log-detail"]').first().click();
   assert.match(await page.locator('.stm-log-pre').textContent(),/日志原文/);
   assert.equal(await page.locator('[data-action="toggle-log-detail"]').first().getAttribute('aria-expanded'),'true');
   const preOver=await page.locator('.stm-page-content').evaluate(el=>el.scrollWidth-el.clientWidth);assert.ok(preOver<=1,`${width} expanded overflow ${preOver}`);
   if(width===390&&theme==='dark')await page.screenshot({path:'.scratch/ui-mobile-redesign/screenshots/logs-updated.png'});
  }
  await go();await page.locator('[data-action="filter-log-key"]').fill('run-2');await page.locator('[data-action="query-logs"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-action="toggle-log-detail"]').length===8);
  await page.locator('.stm-log-tab summary').click();await page.locator('[data-action="filter-log-level"]').selectOption('error');
  assert.ok(await page.locator('[data-action="toggle-log-detail"]').count()>0);
  assert.ok((await page.locator('.stm-log-key').allTextContents()).every(x=>x==='run-2'));
  assert.ok((await page.locator('.stm-log-level').allTextContents()).every(x=>x==='错误'));
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-action="clear-logs"]').click();assert.ok(await page.locator('[data-action="toggle-log-detail"]').count()>0);
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action="clear-logs"]').click();await page.getByText('没有匹配的日志',{exact:true}).waitFor();
  await go();await page.evaluate(()=>{window.__UI_PREVIEW__.runtime.logs.recent=async()=>{throw Error('日志仓库不可用')};window.__UI_PREVIEW__.model.setTab('records')});
  await page.locator('[data-action="open-record"]').first().waitFor();await page.evaluate(()=>window.__UI_PREVIEW__.model.setTab('logs'));
  await page.getByRole('alert').filter({hasText:'日志仓库不可用'}).waitFor();assert.equal(await page.getByText('日志加载失败',{exact:true}).count(),1);
  assert.equal(await page.locator('[data-action="query-logs"]').isEnabled(),true);
  await page.evaluate(()=>{window.__UI_PREVIEW__.runtime.logs.recent=async()=>[{id:123,type:'fill-task',key:'recovered',level:'info',text:'恢复后的日志',createdAt:new Date().toISOString()}]});
  await page.locator('[data-action="query-logs"]').click();await page.getByText('recovered',{exact:true}).waitFor();assert.equal(await page.getByRole('alert').count(),0);
  await page.goto('http://127.0.0.1:8799/?tab=tasks');await page.locator('[data-action="view-task-logs"]:visible').first().waitFor();
  await page.evaluate(()=>{const now=new Date().toISOString();window.__UI_PREVIEW__.runtime.logs.recent=async()=>{await new Promise(r=>setTimeout(r,700));return [{id:900,type:'fill-task',key:'late-recent',level:'info',text:'late',createdAt:now}]};window.__UI_PREVIEW__.runtime.logs.byKey=async key=>{await new Promise(r=>setTimeout(r,30));return [{id:901,type:'fill-task',key,level:'info',text:'focused',createdAt:now}]}});
  await page.locator('[data-action="view-task-logs"]:visible').first().click();await page.locator('[data-log-id="901"]').waitFor();await page.waitForTimeout(800);
  assert.equal(await page.locator('[data-log-id="901"]').count(),1);assert.equal(await page.locator('[data-log-id="900"]').count(),0);
  console.log('PASS logs: widths/theme/large/short viewport, raw expansion, Key+level, clear cancel+accept, initial error+retry, task focus late recent suppression');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
