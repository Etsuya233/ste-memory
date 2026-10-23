const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true});
 const page = await browser.newPage({viewport:{width:390,height:844}});
 try {
  await page.goto('http://127.0.0.1:8799/?tab=records');
  await page.locator('[data-action="open-record"]').first().click();
  const remove=page.locator('[data-action="delete-record"]');
  assert.ok(await remove.evaluate(el=>!!el.closest('.stm-panel-header')));
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();
  assert.equal(await page.evaluate(()=>window.__UI_PREVIEW__.getData().records.filter(r=>r.tableId==='table-people').length),23);
  await page.locator('[data-action="edit-record"]').click();
  assert.equal(await remove.count(),1);
  await page.locator('form textarea').first().fill('临时修改');
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();
  assert.equal(await page.locator('form textarea').first().inputValue(),'临时修改');
  const accept=dialog=>dialog.accept();page.on('dialog',accept);
  await remove.click();await page.locator('[data-action="open-record"]').first().waitFor();page.off('dialog',accept);
  assert.equal(await page.evaluate(()=>window.__UI_PREVIEW__.getData().records.filter(r=>r.tableId==='table-people').length),22);
  assert.equal(await page.locator('[data-action="save-record"]').count(),0);
  await page.locator('[data-action="add-grid-row"]').click();
  assert.equal(await remove.count(),0,'unsaved new records have no delete action');
  console.log('PASS record deletion: header action, cancel, dirty guard, delete returns to list, new record');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
