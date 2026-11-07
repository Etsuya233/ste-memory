import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

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
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function checkTables(scope) {
  const names = await page.evaluate(
    (scope) =>
      window.frontendPreview
        .schemaSnapshot()
        .tables.filter(
          (table) =>
            table.memorySpaceId === `space-${scope}` && table.enabled && table.key !== "full",
        )
        .map((table) => table.key),
    scope,
  );
  await page.waitForFunction((names) => {
    const rows = [...document.querySelectorAll("[data-builtin-macro]")];
    return (
      JSON.stringify(rows.map((row) => row.dataset.builtinMacro)) ===
      JSON.stringify(["", "full", ...names])
    );
  }, names);
  check(`builtins follow chat ${scope} schema without generation`, true);
}
try {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.copiedMacro = text;
        },
      },
    });
  });
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825", {
    timeout: 30000,
    waitUntil: "domcontentloaded",
  });
  await action("nav-settings").click();
  await page.getByRole("button", { name: "记忆宏", exact: true }).click();
  await action("open-builtin-macros").click();
  await checkTables("a");
  await page.getByRole("button", { name: "复制内置宏 摘要", exact: true }).click();
  check(
    "copies default summary token",
    await page.evaluate(() => window.copiedMacro === "{{ste}}"),
  );
  await page.getByRole("button", { name: "复制内置宏 full", exact: true }).click();
  check("copies full token", await page.evaluate(() => window.copiedMacro === "{{ste::full}}"));
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption("b");
  await checkTables("b");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${screenshots}/builtin-macros-320.png` });
  check(
    "320px has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${screenshots}/builtin-macros-desktop.png` });
  await action("page-back").click();
  check("returns to macro settings", await action("open-builtin-macros").isVisible());
  await page.getByRole("button", { name: /前缀与输出上限/ }).click();
  await page.getByLabel("宏前缀", { exact: true }).fill("{{memory}}");
  await action("save-changes").click();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().macroName === "{{memory}}",
  );
  await action("page-back").click();
  await action("open-builtin-macros").click();
  await page.getByRole("button", { name: "复制内置宏 full", exact: true }).click();
  check(
    "copy follows configured prefix",
    await page.evaluate(() => window.copiedMacro === "{{memory::full}}"),
  );
  const tableMacro = page.locator("[data-builtin-macro]").nth(2);
  const tableKey = await tableMacro.getAttribute("data-builtin-macro");
  await tableMacro.getByRole("button").click();
  check(
    "copies table Key token",
    await page.evaluate((key) => window.copiedMacro === `{{memory::${key}}}`, tableKey),
  );
  await action("page-back").click();
  await page.getByRole("button", { name: /全局宏/ }).click();
  await action("create-macro").click();
  await page.getByLabel("宏名", { exact: true }).fill("full");
  await action("save-changes").click();
  await page.getByText("宏已保存。", { exact: true }).waitFor();
  await action("page-back").click();
  await action("page-back").click();
  await action("open-builtin-macros").click();
  check(
    "disabled global macro still shows override",
    await page
      .locator('[data-builtin-macro="full"]')
      .getByText("已被全局宏覆盖", { exact: true })
      .isVisible(),
  );
  await action("page-back").click();
  await page.getByRole("button", { name: /前缀与输出上限/ }).click();
  await page.getByLabel("宏前缀", { exact: true }).fill("");
  await action("save-changes").click();
  await page.waitForFunction(() => window.frontendPreview.settingsSnapshot().macroName === "");
  await action("page-back").click();
  await action("open-builtin-macros").click();
  check(
    "unregistered prefix disables copying",
    await page.getByRole("button", { name: "复制内置宏 full", exact: true }).isDisabled(),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
