const {
  chromium,
} = require("C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const action = (name) => p.locator(`[data-action="${name}"]`);
  const group = async (name) => {
    await p.goto("http://127.0.0.1:8799/?tab=settings");
    await p.evaluate(() => localStorage.clear());
    await p.reload();
    await p.locator(`button[data-group="${name}"]`).click();
  };
  const shot = async (name) => {
    assert.ok(
      (await p.locator(".stm-panel-body").evaluate((e) => e.scrollWidth - e.clientWidth)) <= 1,
      name + " overflow",
    );
    await p.screenshot({
      path: path.join(__dirname, "screenshots", "settings-detail-" + name + ".png"),
    });
  };
  try {
    await group("macro");
    for (const tab of ["builtin", "global", "chat", "settings"]) {
      await p.locator(`[data-macro-scope="${tab}"]`).click();
      await shot("macro-" + tab);
    }
    await p.locator('[data-macro-scope="global"]').click();
    await action("add-memory-view").click();
    await p.locator('[data-stm-field="memory-view-name"]').fill("检查视图");
    await p.locator('[data-stm-field="memory-view-table"]').selectOption({ index: 1 });
    await shot("macro-editor");
    await action("save-memory-view").click();
    assert.equal(await p.locator('[data-stm-section="memory-view-editor"]').count(), 0);
    await group("cleaning");
    p.once("dialog", (d) => d.accept("测试清洗"));
    await action("create-cleaning-list").click();
    await action("add-cleaning-rule").click();
    await p.getByRole("textbox", { name: "规则名称", exact: true }).fill("隐藏标签");
    await p.getByRole("textbox", { name: "开始标签", exact: true }).fill("<hidden>");
    await p.getByRole("textbox", { name: "结束标签", exact: true }).fill("</hidden>");
    await shot("cleaning-editor");
    await action("save-cleaning-rule").click();
    await action("edit-cleaning-rule").click();
    await p.getByRole("combobox", { name: "匹配方式", exact: true }).selectOption("regex");
    assert.equal(await p.getByRole("textbox", { name: "开始标签", exact: true }).count(), 0);
    await p.getByRole("textbox", { name: "正则表达式", exact: true }).fill("secret");
    await p.getByRole("combobox", { name: "处理方式", exact: true }).selectOption("replace");
    assert.equal(await p.getByRole("textbox", { name: "替换内容", exact: true }).count(), 1);
    await shot("cleaning-regex");
    p.once("dialog", (d) => d.accept());
    await action("cancel-cleaning-rule").click();
    await group("agent-presets");
    await action("select-agent-preset").first().click();
    await action("copy-builtin-preset").click();
    await action("toggle-message").first().click();
    await p.getByRole("textbox", { name: "消息名称", exact: true }).fill("系统规则");
    await p.getByRole("textbox", { name: "消息内容", exact: true }).fill("保留事实");
    await p.getByText("插入占位符", { exact: true }).click();
    await action("insert-placeholder").first().click();
    assert.match(
      await p.getByRole("textbox", { name: "消息内容", exact: true }).inputValue(),
      /保留事实\{\{/,
    );
    await shot("agent-message");
    for (const name of [
      "appearance",
      "safe-area",
      "backup",
      "entry",
      "mirror",
      "danger",
      "embedding-connection",
    ]) {
      await group(name);
      await shot(name);
    }
    await group("safe-area");
    await p.locator('[data-stm-field="safe-area-left"]').fill("12");
    await action("clear-safe-area").click();
    assert.equal(await p.locator('[data-stm-field="safe-area-left"]').inputValue(), "0");
    await group("appearance");
    await p.locator('[data-appearance-option="theme"][data-value="light"]').click();
    await p.locator('[data-appearance-option="accent"][data-value="blue"]').click();
    assert.equal(await p.locator("#stm-panel").getAttribute("data-theme"), "light");
    await shot("appearance-light");
    await p.setViewportSize({ width: 360, height: 420 });
    await p.locator('[data-appearance-option="size"][data-value="large"]').click();
    await shot("appearance-short-large");
    assert.deepEqual(errors, []);
    console.log(
      "PASS settings detail interactions, conditional rule fields, macro save, message placeholder, appearance, safe-area reset",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
