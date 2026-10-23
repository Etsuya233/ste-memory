const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
 const browser = await chromium.launch({headless:true, channel:process.env.BROWSER_CHANNEL || 'msedge'});
 const page = await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 const out=path.join(__dirname,'screenshots');fs.mkdirSync(out,{recursive:true});
 const shot=name=>page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
 const go=async tab=>{await page.goto('http://127.0.0.1:8799/?tab='+tab);await page.locator('#stm-panel:popover-open').waitFor();};
 const width=async()=>{const r=await page.locator('#stm-panel').evaluate(el=>({panel:el.scrollWidth-el.clientWidth,body:el.querySelector('main').scrollWidth-el.querySelector('main').clientWidth}));assert.ok(r.panel<=1&&r.body<=1,JSON.stringify(r));};
 try {
  for(const size of [360,390,430,1280]) {
   await page.setViewportSize({width:size,height:844});
   for(const tab of ['records','tables','settings','retrieval','tasks','query','logs']) {
    await go(tab);await page.waitForTimeout(150);await width();if(size===390)await shot(tab);
   }
  }
  await page.setViewportSize({width:390,height:844});await go('records');
  await page.locator('[data-action="open-record"]').first().click();await shot('record-detail');
  await page.locator('[data-action="edit-record"]').click();
  await page.locator('form textarea').first().fill('林澈（更新）');await shot('record-edit');
  await page.locator('[data-action="save-record"]').click();
  await page.locator('[data-action="back-to-records"]').waitFor();
  assert.ok(await page.evaluate(()=>window.__UI_PREVIEW__.getData().records.some(r=>Object.values(r.payload).includes('林澈（更新）'))));
  await page.locator('[data-action="back-to-records"]').click();
  await page.locator('[data-action="add-grid-row"]').click();await page.locator('form textarea').first().fill('未保存的新记录');
  page.once('dialog',d=>d.dismiss());await page.locator('[data-action="cancel-record"]').click();
  assert.equal(await page.locator('[data-action="save-record"]').count(),1);
  page.once('dialog',d=>d.accept());await page.locator('[data-action="cancel-record"]').click();
  assert.equal(await page.locator('[data-action="save-record"]').count(),0);
  await page.locator('[data-action="open-navigation"]').click();await shot('navigation');await page.keyboard.press('Escape');
  assert.ok(await page.locator('[data-action="open-navigation"]').evaluate(el=>el===document.activeElement));
  await go('tables');await page.locator('[data-action="expand-table"]').first().click();
  assert.equal(await page.locator('#stm-panel > .stm-panel-header').isVisible(),false);await shot('table-fields');
  await page.locator('[data-action="edit-field"]').first().click();await shot('field-edit');await page.locator('[data-action="editor-cancel"]').click();
  await page.locator('[data-action="edit-table"]').click();await width();await page.locator('[data-action="editor-submit"]').click();
  await page.locator('[data-action="edit-vector-index"]').click();await width();await page.locator('[data-action="back-to-table-list"]').click();
  assert.ok(await page.locator('[data-action="open-navigation"]').isVisible());
  await go('settings');await page.locator('button[data-group="appearance"]').click();
  const before=await page.locator('.stm-header-title').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
  await page.getByRole('button',{name:'浅色',exact:true}).click();await page.getByRole('button',{name:'大号',exact:true}).click();
  const after=await page.locator('.stm-header-title').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));assert.ok(after>before);
  assert.equal(await page.locator('#stm-panel').getAttribute('data-theme'),'light');await shot('appearance-light');
  await page.locator('[data-action="settings-back"]').click();await shot('settings-light');await width();
  await go('records');await page.locator('[data-action="open-record"]').first().waitFor();await shot('records-light');await width();
  await go('retrieval');await page.locator('[data-action="retrieval-query"]').fill('旧港相识的人');await page.locator('[data-action="retrieval-search"]').click();
  await page.locator('[data-retrieval-hit]').first().waitFor();assert.equal(await page.locator('[data-retrieval-hit]').count(),3);await shot('retrieval-results');
  await page.locator('[data-action="retrieval-open-record"]').first().click();await page.locator('[data-action="back-to-records"]').waitFor();
  await page.setViewportSize({width:1280,height:900});await go('tables');await page.locator('[data-action="expand-table"]').first().waitFor();await shot('tables-desktop');await width();
  assert.deepEqual(errors,[]);
  console.log('PASS: 28 viewport/page checks; record save/cancel, navigation focus, table details, theme/font, retrieval → record; no browser errors.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
