const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const mobile=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await mobile.goto('http://127.0.0.1:8799/?tab=records');
  const button=mobile.locator('[data-action="open-navigation"]');await button.waitFor();await mobile.waitForTimeout(300);
  assert.equal(await mobile.evaluate(()=>matchMedia('(hover: hover) and (pointer: fine)').matches),false);
  const style=()=>button.evaluate(el=>({background:getComputedStyle(el).backgroundColor,transform:getComputedStyle(el.closest(".ui-action-group")).transform}));
  await button.evaluate(el=>el.addEventListener('click',event=>{event.preventDefault();event.stopPropagation()},true));
  const before=await style();const rect=await button.boundingBox();const cdp=await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
  await mobile.waitForTimeout(160);const down=await style();
  assert.ok(Number(down.transform.match(/matrix\(([^,]+)/)[1]) > 1,'panel grows while held');assert.equal(await button.evaluate(el=>getComputedStyle(el).transform),'none','button has no independent scale');await mobile.waitForTimeout(600);assert.deepEqual(await style(),down,'panel stays enlarged while held');assert.notEqual(down.background,before.background);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await mobile.waitForTimeout(180);
  assert.deepEqual(await style(),before,'touch release restores original appearance without sticky hover');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await mobile.waitForTimeout(180);assert.deepEqual(await style(),before,'cancel clears pressed state');
  await mobile.emulateMedia({reducedMotion:'reduce'});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
  assert.equal((await style()).transform,'none');assert.notEqual((await style()).background,before.background);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const desktop=await browser.newPage({viewport:{width:1280,height:900}});await desktop.goto('http://127.0.0.1:8799/?tab=records');
  const back=desktop.locator('[data-action="open-navigation"]');await back.waitFor();
  const normal=await back.evaluate(el=>getComputedStyle(el).backgroundColor);await back.hover();await desktop.waitForTimeout(180);
  assert.notEqual(await back.evaluate(el=>getComputedStyle(el).backgroundColor),normal,'mouse hover remains available');
  await desktop.mouse.move(0,0);await desktop.keyboard.press('Tab');
  const list=desktop.locator('[data-action="open-navigation"]');await list.focus();
  await desktop.keyboard.down('Space');await desktop.waitForTimeout(160);
  assert.notEqual(await list.evaluate(el=>getComputedStyle(el.closest('.ui-action-group')).transform),'none');
  await desktop.keyboard.up('Space');await desktop.waitForTimeout(180);
  assert.equal(await list.evaluate(el=>getComputedStyle(el.closest('.ui-action-group')).transform),'none');
  console.log('PASS touch press/release, reduced-motion feedback, desktop hover');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
