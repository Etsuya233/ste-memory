const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 try {
  await page.goto('http://127.0.0.1:8799/?tab=records');
  await page.locator('.stm-bottom-bar').waitFor();
  await page.evaluate(()=>{const key='ste-memory.appearance.v1';localStorage.setItem(key,JSON.stringify({theme:'light',accent:'teal',font:'system',size:'normal',liquidGlass:true}));window.dispatchEvent(new Event('stm-appearance-change'))});
  await page.addStyleTag({content:'*{text-shadow:0px 0px 4px black}'});
  for(const selector of ['.stm-header-title','.stm-record-summary-title','.ui-icon-button']) {
   assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).textShadow),'none');
  }
  await page.addStyleTag({content:'.stm-page-content{background:repeating-linear-gradient(90deg,#000 0 8px,#fff 8px 16px)} .stm-page-content > *{visibility:hidden}'});
  const header=await page.locator('.stm-panel-header--root').boundingBox();
  const footer=await page.locator('.stm-bottom-bar').boundingBox();
  const screenshot='.scratch/ui-mobile-redesign/screenshots/glass-edge-regression.png';
  await page.screenshot({path:screenshot});
  const result=execFileSync('python',['-c',`
from PIL import Image
im=Image.open(${JSON.stringify(screenshot)})
for name,start,end in [('top',${Math.floor(header.y+header.height)},${Math.ceil(header.y+header.height+48)}),('bottom',${Math.floor(footer.y-48)},${Math.ceil(footer.y)})]:
 jumps=[abs(im.getpixel((x,y))[0]-im.getpixel((x,y-1))[0]) for y in range(start,end) for x in (36,40)]
 assert max(jumps)<12,(name,max(jumps))
 print(name+' edge max luminance step: '+str(max(jumps)))
`],{encoding:'utf8'});
  console.log(result.trim());
  assert.match(await page.locator('.stm-panel-header--root .ui-action-group').first().evaluate(el=>getComputedStyle(el).backdropFilter),/blur/);
  console.log('PASS Chrome: no inherited text shadows, smooth color fade, capsule blur retained');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
