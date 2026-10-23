const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:8799/?tab=settings');
    await page.locator('button[data-group="appearance"]').click();
    const toggle = page.getByRole('switch', { name: 'Liquid Glass' });
    await toggle.locator('..').click();
    assert.ok(await toggle.isChecked());
    assert.equal(await page.locator('#stm-panel').getAttribute('data-glass'), 'true');
    await page.reload();
    assert.equal(await page.locator('#stm-panel').getAttribute('data-glass'), 'true');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        const key = 'ste-memory.appearance.v1';
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), theme }));
      }, theme);
      await page.goto('http://127.0.0.1:8799/?tab=records');
      await page.locator('[data-action="open-record"]').first().waitFor();
      await page.locator('.stm-panel-body').evaluate(element => { element.scrollTop = 180; });
      assert.match(await page.locator('.stm-panel-header--root').evaluate(element => getComputedStyle(element, '::before').backdropFilter), /blur/);
      await page.screenshot({ path: `.scratch/ui-mobile-redesign/screenshots/glass-${theme}.png` });
      assert.ok(await page.locator('.stm-bottom-bar').isVisible());
      await page.locator('[data-action="open-record"]').nth(3).click();
      assert.equal(await page.locator('.stm-panel-header--root').isVisible(), false);
      await page.locator('[data-action="back-to-records"]').click();
      assert.ok(await page.locator('.stm-panel-header--root').isVisible());
    }
    await page.goto('http://127.0.0.1:8799/?tab=settings');
    await page.locator('button[data-group="appearance"]').click();
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.locator('.stm-panel-header--root').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
    assert.deepEqual(errors, []);
    console.log('PASS glass toggle, persistence, dark/light blur, records navigation, disable');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
