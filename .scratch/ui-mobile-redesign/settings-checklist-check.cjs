const {
  chromium,
} = require("C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p.setDefaultTimeout(10000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const action = (name) => p.locator(`[data-action="${name}"]`);
  const shot = async (name) => {
    await p
      .locator(".stm-page-content")
      .first()
      .evaluate((e) => (e.scrollTop = 0));
    await p.screenshot({
      path: path.join(__dirname, "screenshots", "settings-checklist-" + name + ".png"),
    });
  };
  try {
    await p.goto("http://127.0.0.1:8799/?tab=settings");
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        "ste-memory.appearance.v1",
        JSON.stringify({ theme: "light", liquidGlass: true }),
      );
    });
    await p.reload();
    await p.locator('button[data-group="macro"]').click();
    await p.locator('[data-macro-scope="builtin"]').click();
    await p.locator(".stm-macro-list > div").nth(2).waitFor();
    const tabs = await p.getByRole("tablist", { name: "记忆宏作用域" }).boundingBox();
    const list = await p.locator(".stm-macro-list").boundingBox();
    assert.ok(list.y - tabs.y - tabs.height >= 15, "tabs to list spacing");
    assert.equal(await p.locator(".stm-builtin-badge").count(), 0);
    assert.equal(
      await p
        .locator(".stm-macro-list > div")
        .nth(1)
        .evaluate((e) => getComputedStyle(e, "::before").height),
      "1px",
    );
    assert.equal(await p.locator('[data-stm-section="builtin-macros"] details[open]').count(), 1);
    await shot("macro-builtin");
    await p.locator('[data-macro-scope="chat"]').click();
    assert.equal(await p.locator("[data-stm-field=chat-scope-macros-empty]").count(), 0);
    assert.equal(
      await p.locator('[data-stm-section="chat-scope-macros"] details[open]').count(),
      1,
    );
    await shot("macro-chat");
    await action("add-chat-scope-macro").click();
    assert.equal(
      await action("cancel-memory-view").locator("i").getAttribute("class"),
      "fa-solid fa-arrow-left",
    );
    await shot("macro-editor");
    await p.locator('[data-stm-field="memory-view-name"]').fill("草稿");
    p.once("dialog", (d) => d.dismiss());
    await action("cancel-memory-view").click();
    assert.equal(await p.locator('[data-stm-section="memory-view-editor"]').count(), 1);
    p.once("dialog", (d) => d.accept());
    await action("cancel-memory-view").click();
    await action("settings-back").click();
    await p.locator('button[data-group="table-presets"]').click();
    assert.ok(
      (await p.locator(".stm-settings-item-summary").filter({ hasText: "内置" }).count()) >= 2,
    );
    await shot("preset-list");
    await action("open-default-preset").click();
    await shot("preset-default");
    const oldDefault = await p.evaluate(
      () => window.__UI_PREVIEW__.runtime.settings.read().tablePresets.defaultPresetId,
    );
    await action("choose-default-preset").nth(1).click();
    assert.equal(
      await p.evaluate(
        () => window.__UI_PREVIEW__.runtime.settings.read().tablePresets.defaultPresetId,
      ),
      oldDefault,
    );
    p.once("dialog", (d) => d.dismiss());
    await action("back-preset-utility").click();
    assert.equal(await action("choose-default-preset").count(), 2);
    await action("save-default-preset").click();
    await action("open-preset-apply").click();
    await shot("preset-apply");
    assert.equal(await p.locator('[data-stm-field="preset-space-name"]').count(), 1);
    await action("apply-preset").click();
    await p.locator('[data-stm-section="preset-apply-confirm"]').waitFor();
    assert.match(
      await p.locator('[data-stm-field="preset-confirm-text"]').innerText(),
      /清空|删除/,
    );
    await action("cancel-apply-preset").click();
    await action("back-preset-utility").click();
    await action("open-preset-capture").click();
    await shot("preset-capture");
    assert.equal(await p.locator('[data-stm-section="preset-save"] .stm-preset-editor').count(), 0);
    await p.locator('[data-stm-field="preset-save-name"]').fill("结构检查");
    await action("save-space-as-preset").click();
    await action("save-table-preset").waitFor();
    await shot("preset-detail");
    await action("settings-more").click();
    await p.getByRole("menu").waitFor();
    assert.equal(await action("settings-more").getAttribute("aria-expanded"), "true");
    const menu = await p.getByRole("menu").boundingBox();
    assert.ok(
      menu.x >= 0 && menu.x + menu.width <= 390 && menu.y + menu.height <= 844,
      "menu stays in viewport",
    );
    await shot("preset-detail-menu");
    await p.keyboard.press("ArrowDown");
    assert.equal(await p.evaluate(() => document.activeElement.dataset.action), "copy-preset");
    await p.keyboard.press("Escape");
    await p.waitForFunction(
      () =>
        document.querySelector('[data-action="settings-more"]').getAttribute("aria-expanded") ===
        "false",
    );
    assert.equal(await p.evaluate(() => document.activeElement.dataset.action), "settings-more");
    await action("settings-more").click();
    await p.locator(".stm-header-title:visible").click();
    await p.waitForFunction(
      () =>
        document.querySelector('[data-action="settings-more"]').getAttribute("aria-expanded") ===
        "false",
    );
    await action("edit-table-preset").click();
    await action("open-preset-table").first().click();
    const tableTitle = await p.locator(".stm-header-title:visible").innerText();
    assert.equal(
      await p.locator(".stm-header-title:visible").innerText(),
      tableTitle,
      "editing preserves the current table",
    );
    assert.equal(await action("open-preset-table").count(), 0);
    await shot("preset-context-editor");
    await action("settings-more").click();
    assert.equal(await p.getByRole("menuitem", { name: "字段顺序", exact: true }).count(), 1);
    assert.equal(await p.getByText("顺序与删除", { exact: true }).count(), 0);
    await shot("preset-editor-menu");
    await action("order-preset-fields").click();
    assert.equal(await p.locator(".stm-header-title:visible").innerText(), "字段顺序");
    assert.equal(await p.getByRole("button", { name: /上移表格/ }).count(), 0);
    await action("close-table-preset").click();
    await action("close-table-preset").click();
    await action("settings-more").click();
    await action("order-preset-tables").click();
    assert.equal(await p.locator(".stm-header-title:visible").innerText(), "表格顺序");
    assert.equal(await p.getByRole("button", { name: /上移字段/ }).count(), 0);
    await shot("preset-table-order");
    await action("close-table-preset").click();
    await action("close-table-preset").click();
    await action("back-preset-list").click();
    await action("open-preset-apply").click();
    assert.equal(
      await p.locator('[data-stm-field="preset-source-label"]').innerText(),
      "未记录",
      "missing source stays explicit",
    );
    const originalStatus = await p.evaluate(() =>
      structuredClone(window.__UI_PREVIEW__.runtime.manager.getStatus()),
    );
    const changeStatus = async (status) => {
      await p.evaluate((next) => window.__UI_PREVIEW__.setSpaceStatus(next), status);
      await p.waitForTimeout(50);
    };
    await changeStatus({
      ...originalStatus,
      space: {
        ...originalStatus.space,
        initializationSource: {
          presetId: "deleted-source",
          presetName: "已删除预设",
          appliedAt: "2026-10-23T00:00:00Z",
        },
      },
    });
    assert.equal(
      await action("apply-preset").isDisabled(),
      true,
      "deleted source requires selection",
    );
    assert.equal(
      await p.locator('[data-action="choose-apply-preset"][aria-pressed="true"]').count(),
      0,
      "deleted source never picks default silently",
    );
    await action("choose-apply-preset").first().click();
    assert.equal(await action("apply-preset").isDisabled(), false);
    await changeStatus({
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" },
      humanMsg: "空间已解绑",
    });
    assert.equal(
      await action("apply-preset").isDisabled(),
      true,
      "unbound while page is open disables apply",
    );
    assert.equal(
      await p.locator('[data-stm-field="preset-space-name"]').innerText(),
      "无活动记忆空间",
    );
    await shot("preset-apply-unbound");
    await changeStatus(originalStatus);
    assert.deepEqual(errors, []);
    console.log(
      "PASS all macro and preset checklist: spacing/separators/help, independent utilities, capture, menu keyboard/outside/Escape/viewport, editing context and object-specific sorting",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
