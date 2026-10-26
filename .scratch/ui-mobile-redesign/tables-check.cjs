const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const action = name => page.locator(`[data-action="${name}"]:visible`);
  const field = name => page.locator(`[data-stm-field="${name}"]`);
  const openConfig = async name => {
    const control = page.locator(`[data-action="${name}"]`);
    await control.evaluate(el => { const disclosure = el.closest('details'); if (disclosure) disclosure.open = true; });
    await control.click();
  };
  const widthFits = async () => {
    const overflow = await page.locator('.stm-panel-body').evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
    assert.equal(await page.locator('.stm-page-layout').count(), 1, 'single page container owns scrolling');
  };
  try {
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('http://127.0.0.1:8799/?tab=tables');
      await action('expand-table').first().waitFor();
      assert.equal(await action('edit-field').count(), 0, 'list does not show detail at any width');
      await widthFits();
      assert.ok(await action('create-table').evaluate(el => el.closest('.ui-action-group').contains(document.querySelector('[data-action="close-panel"]'))), 'new and close share one capsule');
      const radii = await field('table-search').evaluate(el => ({search: getComputedStyle(el).borderRadius, list: getComputedStyle(document.querySelector('.stm-table-rail-list')).borderRadius, border: getComputedStyle(document.querySelector('.stm-table-rail-list')).borderTopWidth}));
      assert.equal(radii.search, radii.list); assert.equal(radii.border, '1px');
      await action('expand-table').first().click();
      await action('edit-field').first().waitFor();
      assert.equal(await action('expand-table').count(), 0, 'detail has no side rail');
      assert.equal(await page.locator('.stm-panel-header:visible').count(), 1);
      assert.equal(await action('toggle-table').count(), 1, 'one table toggle');
      const toggleGroup = action('toggle-table').locator('xpath=ancestor::*[contains(@class,"ui-action-group")][1]');
      assert.equal(await toggleGroup.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'toggle has no capsule frame');
      await toggleGroup.evaluate(el => el.dataset.frame = 'always');
      assert.notEqual(await toggleGroup.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'forced frame overrides control marker');
      await toggleGroup.evaluate(el => el.dataset.frame = 'auto');
      const mainBox = await action('edit-field').first().boundingBox();
      const rowBox = await action('edit-field').first().locator('..').boundingBox();
      assert.ok(Math.abs(mainBox.height - rowBox.height) < 1 && Math.abs(mainBox.x - rowBox.x) < 1, 'field button includes the row padding');
      const hoverRow = action('edit-field').nth(1).locator('..');
      await page.mouse.move(0, 0);
      const normalRow = await hoverRow.evaluate(el => getComputedStyle(el).backgroundColor);
      await hoverRow.locator('.ui-switch').hover();
      assert.notEqual(await hoverRow.evaluate(el => getComputedStyle(el).backgroundColor), normalRow, 'hover over switch highlights entire row');
      assert.equal(await action('edit-field').nth(1).evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'text button stays transparent');
      assert.equal(await action('toggle-field').first().isDisabled(), true, 'display dependency cannot be disabled');
      await widthFits();
      await page.screenshot({ path: path.join(__dirname, 'screenshots', `table-single-${width}.png`), animations: 'disabled' });
      await action('back-to-table-list').click();
      await action('expand-table').first().waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-action') === 'expand-table');
    }

    for (const glass of [false, true]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width: 390, height: 420 });
        await page.goto('http://127.0.0.1:8799/?tab=tables');
        await page.evaluate(({ glass, theme }) => {
          localStorage.setItem('ste-memory.appearance.v1', JSON.stringify({ theme, accent: 'teal', font: 'system', size: 'large', liquidGlass: glass }));
          window.dispatchEvent(new Event('stm-appearance-change'));
        }, { glass, theme });
        await action('expand-table').first().click();
        await action('edit-field').first().click();
        await widthFits();
        const header = page.locator('.stm-panel-header:visible');
        const top = (await header.boundingBox()).y;
        await page.locator('.stm-panel-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
        assert.ok(Math.abs((await header.boundingBox()).y - top) < 1, 'editing header stays fixed in short viewport');
        assert.ok(await action('editor-submit').isVisible());
        await page.screenshot({ path: path.join(__dirname, 'screenshots', `table-edit-${theme}-${glass}.png`), animations: 'disabled' });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:8799/?tab=tables');
    await field('table-search').fill('不存在的表格');
    assert.equal(await action('expand-table').count(), 0);
    await field('table-search').fill('people');
    assert.equal(await action('expand-table').count(), 1);
    await action('expand-table').click();
    await action('toggle-table').locator('..').click();
    await page.waitForFunction(() => !window.__UI_PREVIEW__.getData().tables[0].enabled);
    await action('toggle-table').locator('..').click();
    await page.waitForFunction(() => window.__UI_PREVIEW__.getData().tables[0].enabled);
    await action('toggle-field-edit').click();
    assert.equal(await action('move-field-up').count(), 0);
    assert.equal(await action('move-field-down').count(), 0);
    assert.ok(await action('delete-field').first().isDisabled(), 'dependent field delete is locked');
    page.once('dialog', dialog => dialog.dismiss());
    await action('delete-field').nth(1).click();
    assert.equal(await action('edit-field').count(), 5, 'cancel delete preserves field');
    await action('toggle-field-edit').click();

    await action('edit-field').first().click();
    assert.ok(await field('field-type').isDisabled(), 'saved field type stays locked');
    await field('field-name').fill('调整后的字段');
    page.once('dialog', dialog => dialog.dismiss());
    await action('editor-cancel').click();
    assert.equal(await field('field-name').inputValue(), '调整后的字段');
    await action('editor-submit').click();
    await action('edit-field').first().waitFor();
    assert.ok(await page.evaluate(() => window.__UI_PREVIEW__.getData().fields.some(f => f.name === '调整后的字段')));

    await openConfig('edit-table');
    await field('table-name').fill('修改后的角色档案');
    await page.evaluate(() => {
      const original = window.__UI_PREVIEW__.runtime.tables.update;
      window.__UI_PREVIEW__.runtime.tables.update = (...args) => new Promise((resolve, reject) => {
        window.__rejectTableSave = () => reject(new Error('预览保存失败'));
        window.__restoreTableSave = () => { window.__UI_PREVIEW__.runtime.tables.update = original; };
      });
    });
    await action('editor-submit').click();
    assert.ok(await action('editor-submit').isDisabled(), 'save locks repeated submission');
    assert.ok(await action('editor-cancel').isDisabled(), 'save locks leaving the editor');
    assert.ok(await action('delete-table').isDisabled(), 'save locks conflicting delete');
    await page.evaluate(() => { window.__rejectTableSave(); window.__restoreTableSave(); });
    await page.waitForFunction(() => !document.querySelector('[data-action="editor-submit"]').disabled);
    assert.equal(await field('table-name').inputValue(), '修改后的角色档案', 'failed save retains draft');
    await action('editor-submit').click();
    await action('edit-field').first().waitFor();
    assert.equal(await page.evaluate(() => window.__UI_PREVIEW__.getData().tables[0].name), '修改后的角色档案');

    assert.ok(await page.locator('.stm-table-settings .stm-settings-item-list').isVisible(), 'configuration list stays visible after saving');
    await openConfig('edit-display-strategy');
    assert.ok(await action('editor-cancel').locator('.fa-chevron-left').count());
    await widthFits();
    await action('editor-cancel').click();
    await openConfig('edit-vector-index');
    await widthFits();
    await action('editor-cancel').click();
    await action('back-to-table-list').click();
    await action('create-table').click();
    await field('table-key').fill('preview_new');
    await field('table-name').fill('测试新表');
    await action('editor-submit').click();
    await page.waitForFunction(() => window.__UI_PREVIEW__.getData().tables.some(t => t.key === 'preview_new'));
    await action('add-field').click();
    await field('field-key').fill('label');
    await field('field-name').fill('标题');
    await action('editor-submit').click();
    await action('edit-field').first().waitFor();
    await openConfig('edit-table');
    page.once('dialog', dialog => dialog.dismiss());
    await action('delete-table').click();
    assert.ok(await field('table-name').isVisible());
    page.once('dialog', dialog => dialog.accept());
    await action('delete-table').click();
    await action('create-table').waitFor();
    assert.equal(await page.evaluate(() => window.__UI_PREVIEW__.getData().tables.some(t => t.key === 'preview_new')), false);
    assert.deepEqual(errors, []);
    console.log('PASS tables: single-column navigation/focus at four widths, short viewport, themes/glass, search, toggles, dependency lock, field edit/delete, field/table save, dirty cancel, busy/failed save, configuration navigation, create/delete');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
