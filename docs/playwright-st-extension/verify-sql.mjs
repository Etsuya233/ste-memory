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
const input = () => page.getByLabel("SQL 语句", { exact: true });
const result = () => page.getByRole("region", { name: "SQL 结果", exact: true });
async function openSQL() {
  await action("nav-settings").click();
  await button("SQL 控制台").click();
}
async function execute(sql) {
  await input().fill(sql);
  await button("执行 SQL").click();
}
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
  await openSQL();
  const count = await page.evaluate(
    () =>
      window.frontendPreview
        .schemaSnapshot()
        .tables.filter((table) => table.memorySpaceId === "space-a").length,
  );
  const schema = page.getByRole("button", { name: `可查询表结构（${count}）`, exact: true });
  await schema.click();
  check(
    "schema lists current space tables",
    (await page.getByRole("button", { name: "查看示例", exact: true }).count()) === count,
  );
  await button("查看示例").first().click();
  check(
    "schema example inserts bounded SELECT",
    /^SELECT \* FROM ".+" LIMIT 20;$/.test(await input().inputValue()),
  );
  await button("执行 SQL").click();
  await result().waitFor();
  check(
    "SQL results preserve named columns and row values",
    (await result().getByRole("columnheader", { name: "name", exact: true }).isVisible()) &&
      (await result().getByRole("columnheader", { name: "notes", exact: true }).isVisible()) &&
      (await result().getByRole("cell", { name: "爱丽丝", exact: true }).isVisible()),
  );
  await execute("invalid");
  await page.getByText("预览模拟：SQL语法错误", { exact: true }).waitFor();
  check(
    "failed SQL clears previous result and keeps query",
    (await result().count()) === 0 && (await input().inputValue()) === "invalid",
  );
  await execute("SELECT 1;");
  await result().waitFor();
  check(
    "valid SQL recovers after error",
    (await page.getByText("预览模拟：SQL语法错误", { exact: true }).count()) === 0,
  );
  await page.evaluate(() => {
    window.__sqlHostKeys = [];
    for (const type of ["keydown", "keyup"])
      window.addEventListener(type, (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
          window.__sqlHostKeys.push(type);
      });
    window.frontendPreview.delaySQL(500);
  });
  await input().fill("SELECT 'keyboard';");
  await input().press("Control+Enter");
  await result().waitFor();
  check(
    "Ctrl Enter executes without reaching host keyboard handlers",
    await page.evaluate(() => window.__sqlHostKeys.length === 0),
  );
  await page.evaluate(() => window.frontendPreview.delaySQL(5000));
  await execute("SELECT 'cancel';");
  await button("取消执行").click();
  await button("执行 SQL").waitFor();
  check(
    "SQL cancellation ends pending execution",
    (await result().count()) === 0 &&
      (await page.getByText("执行失败", { exact: true }).isVisible()),
  );
  await page.evaluate(() => window.frontendPreview.delaySQL(5000));
  await execute("SELECT 'close';");
  await button("取消执行").waitFor();
  await action("close-frontend").click();
  await button("打开预览").focus();
  await button("打开预览").press("Enter");
  await button("执行 SQL").waitFor();
  check("closing workbench aborts pending SQL", (await result().count()) === 0);
  await page.evaluate(() => window.frontendPreview.delaySQL(5000));
  await execute("SELECT 'old chat';");
  await button("取消执行").waitFor();
  await switchChat("b");
  check(
    "switching chat clears SQL draft and results",
    (await input().inputValue()) === "" && (await result().count()) === 0,
  );
  await page.evaluate(() => window.frontendPreview.delaySQL(0));
  await execute("SELECT 'new chat';");
  await result().waitFor();
  check(
    "new chat execution is not replaced by old cancellation",
    (await page.getByText("执行失败", { exact: true }).count()) === 0,
  );
  await switchChat("a");
  check(
    "A to B to A does not revive obsolete SQL output",
    (await input().inputValue()) === "" && (await result().count()) === 0,
  );
  await execute("SELECT 1;");
  await result().waitFor();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${screenshots}/workbench-sql-320.png` });
  check(
    "320px SQL page has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await execute("SELECT 'desktop';");
  await result().waitFor();
  await page.screenshot({ path: `${screenshots}/workbench-sql-desktop.png` });
  check(
    "desktop uses same SQL input and result flow",
    (await input().inputValue()) === "SELECT 'desktop';" &&
      (await page
        .locator("#ste-memory-app")
        .evaluate((element) => element.scrollWidth <= element.clientWidth)),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
