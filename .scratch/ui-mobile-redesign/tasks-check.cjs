const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const action = name => page.locator(`[data-action="${name}"]:visible`);
  const field = name => page.locator(`[data-stm-field="${name}"]:visible`);
  const section = name => page.locator(`[data-stm-section="${name}"]:visible`);
  const widthFits = async () => {
    const overflow = await page.locator('.stm-panel-body').evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}`);
    assert.ok(await page.locator('.stm-bottom-bar:visible').count() <= 1, 'one active page footer');
  };
  try {
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('http://127.0.0.1:8799/?tab=tasks');
      await action('trigger-fill-task').waitFor();
      assert.ok(await section('coverage').evaluate(el => el.open), 'coverage starts expanded');
      assert.ok(await section('trigger').evaluate(el => el.nextElementSibling?.getAttribute('data-stm-section') === 'coverage'), 'coverage follows trigger');
      await action('task-kind-fill').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await action('task-kind-vector').getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await action('task-kind-fill').getAttribute('aria-selected'), 'true');
      await widthFits();
      await page.screenshot({ path: path.join(__dirname, 'screenshots', `tasks-fill-${width}.png`), animations: 'disabled' });
      await action('task-kind-vector').click();
      await action('vector-task-detail').first().waitFor();
      await widthFits();
      await page.screenshot({ path: path.join(__dirname, 'screenshots', `tasks-vector-${width}.png`), animations: 'disabled' });
      await action('vector-page-next').click();
      await page.waitForFunction(() => document.querySelector('.stm-pagination-info')?.textContent.includes('2 /'));
      await action('vector-task-detail').first().click();
      assert.equal(await page.locator('.stm-bottom-bar:visible').count(), 0, 'detail hides list pagination');
      await widthFits();
      await action('vector-detail-back').click();
      await action('task-kind-fill').click();
      assert.equal(await action('vector-page-next').count(), 0, 'hidden vector footer unmounts');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:8799/?tab=tasks');
    await field('range-from').fill('20'); await field('range-to').fill('10');
    await action('trigger-fill-task').click();
    assert.ok((await field('range-error').textContent()).includes('起始楼层'));
    await field('range-from').fill('9'); await field('range-to').fill('12');
    await action('task-kind-vector').click(); await action('task-kind-fill').click();
    assert.equal(await field('range-to').inputValue(), '12', 'switch preserves draft');
    await action('trigger-fill-task').click();
    await action('cancel-task').waitFor();
    assert.ok(await page.evaluate(() => window.__UI_PREVIEW__.getData().fill.some(t => t.status === 'running' && t.from === 9 && t.to === 12)));
    await action('task-kind-vector').click();
    assert.equal(await action('cancel-task').count(), 0, 'fill footer does not leak into vector');
    await action('task-kind-fill').click(); await action('cancel-task').click();
    await action('trigger-fill-task').waitFor();
    assert.equal(await page.evaluate(() => window.__UI_PREVIEW__.getData().fill.filter(t => t.status === 'running').length), 0);
    await section('mark-ledger').locator('summary').click();
    await field('mark-from').fill('10'); await field('mark-to').fill('11');
    page.once('dialog', dialog => dialog.dismiss()); await action('mark-floor-statuses').click();
    assert.equal(await page.evaluate(() => window.__UI_PREVIEW__.getData().ledger.some(item => item.floor === 10)), false);
    page.once('dialog', dialog => dialog.accept()); await action('mark-floor-statuses').click();
    await page.waitForFunction(() => window.__UI_PREVIEW__.getData().ledger.some(item => item.floor === 10));
    await section('init-fill').locator('summary').click();
    await field('init-text').fill('雨夜旧港的初始人物与约定');
    await action('trigger-init-fill').click(); await action('cancel-task').waitFor();
    assert.ok(await page.evaluate(() => window.__UI_PREVIEW__.getData().fill.some(t => t.status === 'running' && t.kind === 'init')));
    await action('cancel-task').click(); await action('trigger-fill-task').waitFor();
    await action('retry-task').first().click(); await action('cancel-task').waitFor();
    await action('cancel-task').click(); await action('trigger-fill-task').waitFor();

    await action('task-kind-vector').click();
    await page.waitForFunction(() => document.querySelector('.stm-pagination-info')?.textContent.includes('1 /'));
    const checks = section('vector-tasks').locator('input[type="checkbox"]:enabled');
    await checks.nth(0).check(); await checks.nth(1).check();
    await action('cancel-selected-vector-tasks').click();
    await page.waitForFunction(() => window.__UI_PREVIEW__.getData().vectors.filter(t => t.status === 'cancelled').length >= 3);
    assert.equal(await action('cancel-selected-vector-tasks').count(), 0);
    await action('filter-vector-status').selectOption('failed');
    await action('retry-vector-task').first().waitFor();
    assert.equal(await section('vector-tasks').locator('input[type="checkbox"]:enabled').count(), 0, 'terminal tasks cannot be selected');
    const vectorCount = await page.evaluate(() => window.__UI_PREVIEW__.getData().vectors.length);
    await action('retry-vector-task').first().click();
    await page.waitForFunction(count => window.__UI_PREVIEW__.getData().vectors.length > count, vectorCount);
    await action('filter-vector-status').selectOption('active');
    await section('vector-tasks').locator('summary').filter({hasText: '筛选任务'}).click();
    await action('filter-vector-search').fill('林澈');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-action="vector-task-detail"]')].length > 0 && [...document.querySelectorAll('[data-action="vector-task-detail"]')].every(el => el.textContent.includes('林澈')));
    await action('filter-vector-source').selectOption('manual');
    await action('vector-task-detail').first().waitFor();
    await action('reset-vector-filters').click();
    await action('vector-task-detail').first().waitFor();
    await page.locator('.stm-panel-body').evaluate(el => { el.scrollTop = 400; });
    const scroll = await page.locator('.stm-panel-body').evaluate(el => el.scrollTop);
    await page.waitForTimeout(2200);
    assert.ok(Math.abs(await page.locator('.stm-panel-body').evaluate(el => el.scrollTop) - scroll) < 2, 'polling preserves scroll');
    for (const theme of ['light', 'dark']) {
      for (const glass of [false, true]) {
        await page.setViewportSize({width: 390, height: 420});
        await page.evaluate(({theme, glass}) => {
          localStorage.setItem('ste-memory.appearance.v1', JSON.stringify({theme, accent:'teal', font:'system', size:'large', liquidGlass:glass}));
          window.dispatchEvent(new Event('stm-appearance-change'));
        }, {theme, glass});
        await widthFits();
        const footer = page.locator('.stm-bottom-bar');
        const footerTop = (await footer.boundingBox()).y;
        await page.locator('.stm-panel-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
        const lastRow = await action('vector-task-detail').last().boundingBox();
        assert.ok(lastRow.y + lastRow.height <= footerTop + 1, 'last task clears fixed footer');
        await action('vector-task-detail').last().click(); await widthFits();
        await page.screenshot({path:path.join(__dirname,'screenshots',`task-detail-${theme}-${glass}.png`),animations:'disabled'});
        await action('vector-detail-back').click();
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS tasks: four widths, fill/vector navigation and footer ownership, draft persistence, range validation, submit/cancel/retry/init, ledger confirmation, vector pagination/detail/batch cancel');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
