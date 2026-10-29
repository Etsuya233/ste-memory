import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const url = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const query = async (scope) =>
  JSON.stringify(
    {
      table: await page.evaluate(
        (scope) =>
          window.frontendPreview
            .schemaSnapshot()
            .tables.find((table) => table.memorySpaceId === `space-${scope}`).key,
        scope,
      ),
      limit: 5,
    },
    null,
    2,
  );
async function switchChat(key) {
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.workspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour"),
    key,
  );
}
try {
  await page.goto(url);
  await action("nav-settings").click();
  await button("记忆宏").click();
  await page.getByRole("button", { name: /前缀与输出上限/ }).click();
  await page.getByLabel("宏前缀", { exact: true }).fill("{{memory}}");
  await page.getByLabel("默认输出字符上限", { exact: true }).fill("1250");
  await action("save-changes").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.settingsSnapshot().macroName === "{{memory}}" &&
      window.frontendPreview.settingsSnapshot().macroLimit === 1250,
  );
  check("macro prefix and limit persist through settings service", true);
  await action("page-back").click();
  await page.getByRole("button", { name: /全局宏/ }).click();
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("人物摘要");
  await action("macro-query").fill(await query("a"));
  await page.getByRole("switch", { name: "启用宏", exact: true }).click();
  await page.getByLabel("输出格式", { exact: true }).selectOption("markdown");
  await page.getByLabel("此宏输出字符上限", { exact: true }).fill("500");
  await action("test-macro").click();
  await page.getByRole("region", { name: "宏测试结果", exact: true }).waitFor();
  check(
    "draft macro test renders service output",
    await page.getByText("预览模拟输出：雨后书店", { exact: true }).isVisible(),
  );
  check(
    "testing does not persist draft",
    await page.evaluate(() => window.frontendPreview.settingsSnapshot().macros.length === 0),
  );
  await action("save-changes").click();
  await page.waitForFunction(() => window.frontendPreview.settingsSnapshot().macros.length === 1);
  check(
    "query macro persists output options",
    await page.evaluate(() => {
      const macro = window.frontendPreview.settingsSnapshot().macros[0];
      return (
        macro.name === "人物摘要" &&
        macro.output.format === "markdown" &&
        macro.output.maxChars === 500 &&
        macro.enabled
      );
    }),
  );
  await action("macro-query").fill("{bad JSON");
  await action("save-changes").click();
  await page
    .locator('[role="alert"]')
    .filter({ hasText: /JSON|Unexpected|Expected/ })
    .waitFor();
  check(
    "invalid query leaves persisted macro untouched",
    await page.evaluate(
      () => window.frontendPreview.settingsSnapshot().macros[0].expression.language === "query",
    ),
  );
  await page.getByLabel("表达式语言", { exact: true }).selectOption("sql");
  await action("macro-sql").fill('SELECT 1 AS "count"');
  await action("save-changes").click();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().macros[0].expression.language === "sql",
  );
  check("SQL macro editing persists", true);
  await action("page-back").click();
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("人物摘要");
  await action("macro-query").fill(await query("a"));
  await action("save-changes").click();
  await page.getByText("宏名已存在", { exact: true }).waitFor();
  check(
    "duplicate macro name is rejected without overwriting",
    await page.evaluate(() => window.frontendPreview.settingsSnapshot().macros.length === 1),
  );
  await action("page-back").click();
  await button("放弃修改并继续").click();
  await action("page-back").click();
  await page.getByRole("button", { name: /当前对话宏/ }).click();
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("书店对话宏");
  await action("macro-query").fill(await query("a"));
  await page.evaluate(() => window.frontendPreview.delayMacroTest(800));
  await action("test-macro").click();
  await switchChat("b");
  await switchChat("a");
  await page.getByText("测试期间对话已切换，请在当前对话重新测试。", { exact: true }).waitFor();
  check(
    "A to B to A rejects obsolete macro test output",
    (await page.getByRole("region", { name: "宏测试结果", exact: true }).count()) === 0,
  );
  await page.evaluate(() => window.frontendPreview.delayMacroTest(0));
  await switchChat("b");
  check("chat B does not display chat A draft", await action("create-macro").isVisible());
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "retained draft in another chat protects navigation",
    await action("create-macro").isVisible(),
  );
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("港口草稿");
  await action("macro-query").fill(await query("b"));
  await switchChat("a");
  check(
    "returning to chat A restores its macro draft",
    (await page.getByLabel("宏名", { exact: true }).inputValue()) === "书店对话宏",
  );
  await action("save-changes").click();
  await page.getByText("宏已保存。", { exact: true }).waitFor();
  await action("page-back").click();
  check(
    "chat macro saved to chat A list",
    await page.getByRole("button", { name: /memory::书店对话宏/ }).isVisible(),
  );
  await switchChat("b");
  check(
    "chat B draft survives chat A save",
    (await page.getByLabel("宏名", { exact: true }).inputValue()) === "港口草稿",
  );
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "dirty macro protects workbench navigation",
    (await page.getByLabel("宏名", { exact: true }).inputValue()) === "港口草稿",
  );
  await action("page-back").click();
  await button("放弃修改并继续").click();
  await switchChat("a");
  await page.getByRole("button", { name: /memory::书店对话宏/ }).click();
  await action("delete-macro").click();
  await button("删除宏").click();
  await page.getByText("宏已删除。", { exact: true }).waitFor();
  check(
    "chat macro deletion updates current collection",
    await page.getByText("还没有对话宏", { exact: true }).isVisible(),
  );
  await action("page-back").click();
  await page.getByRole("button", { name: "可用宏与最近展开内容", exact: true }).click();
  check(
    "built in overview shows actual provided snapshot",
    await page.getByText("预览模拟快照：雨后书店", { exact: true }).isVisible(),
  );
  await page.getByRole("button", { name: /全局宏/ }).click();
  await action("open-macro").filter({ hasText: "人物摘要" }).click();
  await action("delete-macro").click();
  await button("删除宏").click();
  await page.waitForFunction(() => window.frontendPreview.settingsSnapshot().macros.length === 0);
  check(
    "global macro deletion preserves other settings",
    await page.evaluate(() => window.frontendPreview.settingsSnapshot().macroLimit === 1250),
  );
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("移动端宏");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${screenshots}/workbench-macros-320.png` });
  check(
    "320px macro editor has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
