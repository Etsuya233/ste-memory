const {
  chromium,
} = require("C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.setDefaultTimeout(15000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    const shot = async (name) => {
      await p.waitForTimeout(120);
      await p.screenshot({
        path: path.join(__dirname, "screenshots", `macro-refactor-${name}.png`),
      });
    };
    await p.goto("http://127.0.0.1:8799/?tab=settings");
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        "ste-memory.appearance.v1",
        JSON.stringify({ theme: "light", liquidGlass: true, size: "large" }),
      );
    });
    await p.reload();
    await p.locator('button[data-group="macro"]').click();

    // 三作用域 + 摘要条 + 空态
    assert.equal(await p.locator('[data-action="macro-scope"]').count(), 3);
    assert.equal(await p.locator('[data-macro-scope="settings"]').count(), 0);
    assert.match(
      await p.locator('[data-stm-field="macro-status"]').innerText(),
      /\{\{ste\}\}/,
    );
    assert.match(
      await p.locator('[data-stm-field="macro-status"]').innerText(),
      /0 \/ 2000 字/,
    );
    assert.equal(await p.locator('[data-stm-section="macro-empty"]').count(), 1);

    // 空态 CTA 创建全局宏
    await p.locator('[data-stm-section="macro-empty"] [data-action="add-memory-view"]').click();
    await p.locator('[data-stm-field="memory-view-name"]').fill("未完成伏笔");
    await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
    assert.match(
      await p.locator('[data-stm-field="memory-view-token"]').innerText(),
      /\{\{ste::未完成伏笔\}\}/,
    );
    await p.waitForTimeout(200);
    await p.locator('[data-action="toggle-projection-field"]').first().click();
    await p.locator('[data-stm-field="memory-view-limit"]').fill("20");
    await shot("editor-filled");
    await p.locator('[data-action="save-memory-view"]').click();
    await p.waitForTimeout(250);
    assert.equal(await p.locator('[data-action="edit-memory-view"]').count(), 1);
    assert.match(
      await p.locator('[data-stm-field="memory-view-未完成伏笔"]').innerText(),
      /\{\{ste::未完成伏笔\}\}/,
    );
    assert.equal(await p.locator('[data-action="copy-memory-view-token"]').count(), 1);
    await shot("global-list");

    // 全局宏行预览（眼睛按钮）
    await p.locator('[data-action="preview-macro"]').click();
    assert.equal(await p.locator('[data-stm-section="preview-modal"]').count(), 1);
    await p.locator('[data-action="close-preview-modal"]').click();

    // 编辑页已保存输出入口在顶部
    await p.locator('[data-action="edit-memory-view"]').click();
    assert.equal(await p.locator('[data-stm-field="memory-view-preview"]').count(), 1);
    await p.locator('[data-action="cancel-memory-view"]').click();

    // 宏设置页：合法 → 非法 → 恢复；上限即时保存；返回
    await p.locator('[data-action="open-macro-settings"]').click();
    assert.equal(await p.locator('[data-stm-section="macro-settings"]').count(), 1);
    assert.match(
      await p.locator('[data-stm-field="macro-name-status"]').innerText(),
      /已注册为/,
    );
    await p.locator('[data-stm-field="macro-name"]').fill("{{我的记忆}}");
    await p.waitForTimeout(250);
    assert.equal(
      await p.locator('[data-stm-field="macro-name-status"]').getAttribute("data-state"),
      "invalid",
    );
    await shot("settings-invalid");
    await p.locator('[data-stm-field="macro-name"]').fill("{{ste}}");
    await p.waitForTimeout(250);
    await p.locator('[data-stm-field="macro-limit"]').fill("1500");
    await p.waitForTimeout(250);
    assert.match(
      await p.locator('[data-stm-field="macro-budget-value"]').innerText(),
      /1500 字/,
    );
    await p.getByText("使用说明", { exact: true }).click();
    await shot("settings-help");
    await p.locator('[data-action="close-macro-settings"]').click();
    assert.equal(await p.getByRole("tablist", { name: "记忆宏作用域" }).count(), 1);

    // 对话宏：同名覆盖提示 + 列表
    await p.locator('[data-macro-scope="chat"]').click();
    await p.waitForTimeout(120);
    assert.equal(await p.locator("[data-stm-section=macro-empty]").count(), 1);
    await p.locator('[data-stm-section="macro-empty"] [data-action="add-chat-scope-macro"]').click();
    await p.locator('[data-stm-field="memory-view-name"]').fill("未完成伏笔");
    await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
    await p.locator('[data-action="save-memory-view"]').click();
    await p.waitForTimeout(250);
    assert.equal(await p.locator('[data-action="edit-chat-scope-macro"]').count(), 1);
    assert.match(
      await p.locator('[data-stm-field="chat-macro-未完成伏笔"]').innerText(),
      /覆盖全局/,
    );
    await shot("chat-list");

    // 内置宏：分组 + 状态 + 预览弹窗
    await p.locator('[data-macro-scope="builtin"]').click();
    await p.waitForTimeout(300);
    assert.match(
      await p.locator('[data-stm-section="builtin-macros"]').innerText(),
      /默认快照/,
    );
    assert.match(
      await p.locator('[data-stm-section="builtin-macros"]').innerText(),
      /Agent 预设宏/,
    );
    await p.locator('[data-action="preview-macro"]').first().click();
    assert.equal(await p.locator('[data-stm-section="preview-modal"]').count(), 1);
    await p.locator('[data-action="close-preview-modal"]').click();
    await shot("builtin");

    // 窄屏横向溢出
    for (const width of [360, 430]) {
      await p.setViewportSize({ width, height: 844 });
      await p.waitForTimeout(120);
      const overflow = await p
        .locator(".stm-page-content")
        .evaluate((e) => e.scrollWidth - e.clientWidth);
      assert.ok(overflow <= 1, `overflow at ${width}px: ${overflow}`);
    }

    assert.deepEqual(errors, []);
    console.log("PASS macro refactor: empty states, scopes, editor token, settings validation, chat override, builtin groups, overflow");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
