const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const glass of [false, true]) {
      for (const height of [844, 420]) {
        await page.setViewportSize({ width: 390, height });
        await page.goto('http://127.0.0.1:8799/?tab=records');
        await page.evaluate(glass => {
          const key = 'ste-memory.appearance.v1';
          localStorage.setItem(key, JSON.stringify({ theme: 'light', accent: 'teal', font: 'system', size: 'large', liquidGlass: glass }));
          window.dispatchEvent(new Event('stm-appearance-change'));
        }, glass);
        const header = page.locator('.stm-panel-header--root');
        const footer = page.locator('.stm-bottom-bar');
        await footer.waitFor();
        await header.evaluate(element => {
          const extension = document.createElement('div');
          extension.className = 'stm-header-extension';
          extension.style.height = '72px';
          extension.textContent = '多行扩展区域';
          element.append(extension);
        });
        await page.waitForFunction(() => {
          const layout = document.querySelector('.stm-page-layout');
          const host = layout.querySelector('.stm-page-header');
          return Math.abs(parseFloat(getComputedStyle(layout).getPropertyValue('--stm-page-header-height')) - host.getBoundingClientRect().height) < 1;
        });
        const firstControl = await page.locator('[data-action="records-list-view"]').boundingBox();
        const headerRect = await header.boundingBox();
        assert.ok(firstControl.y >= headerRect.y + headerRect.height - 1, `content clears measured multi-row header: glass=${glass}, height=${height}, control=${firstControl.y}, headerBottom=${headerRect.y + headerRect.height}, host=${await header.evaluate(el=>JSON.stringify({height:el.parentElement.parentElement.getBoundingClientRect().height,position:getComputedStyle(el.parentElement.parentElement).position,gridRow:getComputedStyle(el.parentElement.parentElement).gridRow,token:getComputedStyle(el.closest(".stm-page-layout")).getPropertyValue("--stm-page-header-height")}))}, body=${await page.locator(".stm-panel-body").evaluate(el=>JSON.stringify({scroll:el.scrollTop,padding:getComputedStyle(el).paddingTop}))}`);
        await footer.evaluate(element => { element.style.minHeight = '104px'; });
        await page.waitForFunction(() => {
          const layout = document.querySelector('.stm-page-layout');
          const host = layout.querySelector('.stm-page-footer');
          return Math.abs(parseFloat(getComputedStyle(layout).getPropertyValue('--stm-page-footer-height')) - host.getBoundingClientRect().height) < 1;
        });
        await page.locator('.stm-panel-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
        const lastRow = await page.locator('[data-action="open-record"]').last().boundingBox();
        const footerRect = await footer.boundingBox();
        assert.ok(lastRow.y + lastRow.height <= footerRect.y + 1, 'last row clears resized footer');
        assert.ok(footerRect.y + footerRect.height <= height + 1, 'footer fits short viewport');
        await page.locator('[data-action="add-grid-row"]').click();
        await page.locator('[data-action="save-record"]').waitFor();
        assert.equal(await footer.count(), 0, 'editor removes page footer');
        assert.ok(await page.locator('[data-action="cancel-record"]').isVisible());
        await page.locator('[data-action="cancel-record"]').click();
        await footer.waitFor();
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS PageLayout: measured extension/footer, short viewport, glass/plain, editor slots');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
