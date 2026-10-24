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
  const body = p.locator(".stm-page-content").first();
  const shot = async (name) => {
    await body.evaluate((e) => (e.scrollTop = 0));
    await p.waitForTimeout(100);
    assert.equal(await p.locator(".stm-panel-header:visible").count(), 1);
    await p.screenshot({
      path: path.join(__dirname, "screenshots", `settings-navigation-${name}.png`),
    });
  };
  const group = async (name) => {
    await p.goto("http://127.0.0.1:8799/?tab=settings");
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        "ste-memory.appearance.v1",
        JSON.stringify({ theme: "light", liquidGlass: true, size: "large" }),
      );
    });
    await p.reload();
    await p.locator(`button[data-group="${name}"]`).click();
  };
  try {
    await group("macro");
    await action("add-memory-view").click();
    assert.equal(await p.getByRole("tablist", { name: "记忆宏作用域" }).count(), 0);
    await shot("macro-create");
    await p.locator('[data-stm-field="memory-view-name"]').fill("新宏");
    await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
    await action("save-memory-view").click();
    assert.equal(await p.getByRole("tablist", { name: "记忆宏作用域" }).count(), 1);
    // Unsaved creation stays in the editor when cancelled, and discard leaves no object.
    await action("add-memory-view").click();
    await p.locator('[data-stm-field="memory-view-name"]').fill("放弃草稿");
    p.once("dialog", (d) => d.dismiss());
    await action("cancel-memory-view").click();
    assert.equal(await p.locator('[data-stm-section="memory-view-editor"]').count(), 1);
    p.once("dialog", (d) => d.accept());
    await action("cancel-memory-view").click();
    assert.equal(await action("edit-memory-view").count(), 1);
    // A long object list restores its own return position; new/edit forms open at the top.
    for (let i = 0; i < 14; i++) {
      await action("add-memory-view").click();
      await p.waitForFunction(() => document.querySelector(".stm-page-content").scrollTop === 0);
      assert.equal(await body.evaluate((e) => e.scrollTop), 0);
      await p.locator('[data-stm-field="memory-view-name"]').fill("列表宏" + i);
      await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
      await action("save-memory-view").click();
    }
    await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
    await p.waitForTimeout(100);
    const listScroll = await body.evaluate((e) => e.scrollTop);
    assert.ok(listScroll > 100);
    await action("edit-memory-view").last().click();
    await p.waitForTimeout(100);
    assert.equal(await body.evaluate((e) => e.scrollTop), 0);
    await action("cancel-memory-view").click();
    await p.waitForTimeout(100);
    assert.ok(
      Math.abs((await body.evaluate((e) => e.scrollTop)) - listScroll) <= 2,
      "macro list return scroll",
    );
    await action("add-memory-view").click();
    await p.waitForTimeout(100);
    assert.equal(await body.evaluate((e) => e.scrollTop), 0, "new form is fresh");
    await action("cancel-memory-view").click();
    await shot("macro-list");
    await p.locator('[data-macro-scope="chat"]').click();
    await action("add-chat-scope-macro").click();
    await p.locator('[data-stm-field="memory-view-name"]').fill("对话验证");
    await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
    await action("save-memory-view").click();
    assert.equal(await action("edit-chat-scope-macro").count(), 1);
    await action("edit-chat-scope-macro").click();
    await p.getByText("已保存的宏输出", { exact: true }).click();
    assert.equal(await action("copy-macro-preview").count(), 1);
    await action("cancel-memory-view").click();
    await group("table-presets");
    await shot("preset-list");
    await action("open-table-preset").first().click();
    await shot("preset-detail");
    await action("edit-table-preset").click();
    await shot("preset-editor");
    await action("open-preset-table").first().click();
    await shot("preset-table-fields");
    await action("edit-field").first().click();
    await shot("preset-field-editor");
    await p.getByText("字段约束", { exact: true }).click();
    const originalMaxChars = await p.getByLabel("最大字符数", { exact: true }).inputValue();
    await p.getByLabel("最大字符数", { exact: true }).fill("123");
    p.once("dialog", (d) => d.accept());
    await action("close-table-preset").click();
    await action("edit-field").first().click();
    await p.getByText("字段约束", { exact: true }).click();
    assert.equal(
      await p.getByLabel("最大字符数", { exact: true }).inputValue(),
      originalMaxChars,
      "cancel discards field constraints",
    );
    await p.locator('[data-stm-field="field-name"]').fill("已验证名称");
    assert.equal(
      await p.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true }))),
      false,
      "field draft protects page leave",
    );
    await action("save-preset-field").click();
    await action("save-table-preset").click();
    const saved = await p.evaluate(
      () => window.__UI_PREVIEW__.runtime.settings.read().tablePresets.userPresets[0],
    );
    assert.equal(saved.tables[0].fields[0].name, "已验证名称");
    await action("open-table-preset").filter({ hasText: saved.name }).click();
    await action("open-preset-table").first().click();
    await action("edit-field").first().click();
    assert.equal(
      await p.locator('[data-stm-field="field-name"]').inputValue(),
      "已验证名称",
      "overall save persists to reopened editor",
    );
    await action("close-table-preset").click();
    await action("close-table-preset").click();
    await action("close-table-preset").click();
    await shot("preset-saved-detail");
    await group("agent-presets");
    await shot("agent-list");
    await action("select-agent-preset").first().click();
    await action("copy-builtin-preset").click();
    await shot("agent-messages");
    await action("toggle-message").first().click();
    await shot("agent-message");
    await p.getByRole("textbox", { name: "消息名称", exact: true }).fill("独立消息");
    await p.getByRole("textbox", { name: "消息内容", exact: true }).fill("事实 {{tablesDigest}}");
    await p.getByText("插入占位符", { exact: true }).click();
    await action("insert-placeholder").first().click();
    await action("back-agent-message").click();
    await action("preview-preset").click();
    await p.locator('[data-stm-section="preset-preview"]').waitFor();
    await action("close-preview-modal").click();
    await action("back-agent-presets").click();
    const active = await p.evaluate(
      () => window.__UI_PREVIEW__.runtime.settings.read().agentPresets.activePresetId,
    );
    await action("select-agent-preset").first().click();
    assert.equal(
      await p.evaluate(
        () => window.__UI_PREVIEW__.runtime.settings.read().agentPresets.activePresetId,
      ),
      active,
      "browsing does not activate",
    );
    await action("activate-agent-preset").click();
    assert.equal(
      await p.evaluate(
        () => window.__UI_PREVIEW__.runtime.settings.read().agentPresets.activePresetId,
      ),
      "systemDefault",
    );
    await action("back-agent-presets").click();
    const agentImport = {
      format: "ste-memory-agent-preset",
      version: 2,
      exportedAt: "2026-10-23T00:00:00Z",
      preset: {
        id: "imported-test",
        name: "导入验证",
        messages: [
          {
            id: "im1",
            name: "导入消息",
            role: "system",
            content: "{{tablesDigest}}",
            enabled: true,
          },
        ],
      },
    };
    await p.locator('[data-stm-section="agent-presets"] input[type=file]').setInputFiles({
      name: "preset.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(agentImport)),
    });
    await action("toggle-message").filter({ hasText: "导入消息" }).waitFor();
    await action("back-agent-presets").click();
    assert.ok((await action("select-agent-preset").count()) >= 3);
    await group("cleaning");
    await shot("cleaning-list");
    p.once("dialog", (d) => d.accept("清洗验证"));
    await action("create-cleaning-list").click();
    await action("add-cleaning-rule").click();
    await p.getByRole("textbox", { name: "规则名称", exact: true }).fill("隐藏标签");
    await p.getByRole("textbox", { name: "开始标签", exact: true }).fill("<hidden>");
    await p.getByRole("textbox", { name: "结束标签", exact: true }).fill("</hidden>");
    await shot("cleaning-rule");
    p.once("dialog", (d) => d.dismiss());
    await action("cancel-cleaning-rule").click();
    assert.equal(await p.locator('[data-cleaning-screen="rule"]').count(), 1);
    await action("save-cleaning-rule").click();
    await shot("cleaning-rules");
    await action("add-cleaning-rule").click();
    await p.getByRole("textbox", { name: "规则名称", exact: true }).fill("第二条");
    await p.getByRole("combobox", { name: "匹配方式", exact: true }).selectOption("regex");
    await p.getByRole("textbox", { name: "正则表达式", exact: true }).fill("secret");
    await action("save-cleaning-rule").click();
    await p.getByText("规则顺序", { exact: true }).click();
    await action("move-cleaning-rule-down").first().click();
    assert.equal(
      await p.evaluate(
        () => window.__UI_PREVIEW__.runtime.settings.read().cleaningRuleLists[0].rules[0].name,
      ),
      "第二条",
    );
    await action("test-cleaning-list").click();
    await p.locator('[data-stm-field="cleaning-test-input"]').fill("secret");
    await action("run-cleaning-test").click();
    assert.equal(await p.locator('[data-stm-field="cleaning-test-result"]').count(), 1);
    await action("close-cleaning-test").click();
    await action("back-cleaning-lists").click();
    await shot("cleaning-list-populated");
    await p.locator('[data-stm-field="chat-cleaning-list"]').selectOption({ index: 1 });
    await action("open-cleaning-list").click();
    await p.getByText("列表操作", { exact: true }).click();
    await action("import-st-regex").click();
    const regex = {
      id: "rx1",
      scriptName: "导入规则",
      findRegex: "secret",
      replaceString: "",
      trimStrings: [],
      placement: [1, 2],
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: false,
      substituteRegex: 0,
    };
    await p.locator('[data-stm-section="regex-import-dialog"] input[type=file]').setInputFiles({
      name: "regex.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify([regex])),
    });
    await p.locator('[data-action="toggle-import-candidate"]').check();
    await action("confirm-regex-import").click();
    assert.equal(await action("edit-cleaning-rule").count(), 3);
    await shot("cleaning-imported");
    assert.deepEqual(errors, []);
    console.log("PASS macro create/save, preset list/detail/editor/table/field headers");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
