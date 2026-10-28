import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const scroll = () => page.locator('[data-page-scroll="tables"]');
async function back() {
  await action("page-back").click();
}
async function openTable() {
  await action("nav-tables").click();
  await page.locator('[data-action="open-table"]').filter({ hasText: "人物" }).click();
}
async function openFirstRecord() {
  await action("open-vector-record").click();
  await page.getByTestId("vector-preview-record-title").waitFor();
  await page.getByLabel("正在加载向量预览").waitFor({ state: "hidden" });
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await openTable();
  await page.getByRole("button", { name: /向量索引/ }).click();
  await action("preview-vector-records").click();
  await action("open-vector-record").waitFor();
  check(
    "preview choices use paginated records",
    (await page.locator('[data-action="open-vector-record"]').count()) === 20,
  );
  await back();
  await page.evaluate(async () => {
    await window.frontendPreview.seedSearch();
    await window.frontendPreview.tablesWorkspace.refresh();
  });
  await action("preview-vector-records").click();
  await openFirstRecord();
  const input = await page.getByTestId("vector-preview-input").first().textContent();
  check(
    "preview uses final field labels and values",
    input.includes("名称：爱丽丝") && input.includes("描述："),
  );
  check("reference fields render target display text", input.includes("常去地点：雨巷书店"));
  check(
    "preview reports exact character count",
    (await page.locator("[data-vector-group]").first().textContent()).includes(
      `${input.length} 字符`,
    ),
  );
  check(
    "preview does not request query embeddings",
    await page.evaluate(() => window.frontendPreview.searchService.getState().calls === 0),
  );
  await back();
  await label("查找记录").fill("爱丽丝");
  await button("搜索预览记录").click();
  await action("open-vector-record").waitFor();
  check(
    "preview record search uses display text",
    (await page.locator('[data-action="open-vector-record"]').count()) === 1,
  );
  await label("查找记录").fill("");
  await button("搜索预览记录").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.tablesWorkspace.getSnapshot().vectorPreview.records.records.length ===
      20,
  );
  await scroll().evaluate((element) => {
    element.scrollTop = 500;
  });
  await page.waitForTimeout(50);
  const offset = await scroll().evaluate((element) => element.scrollTop);
  await page
    .locator('[data-action="open-vector-record"]')
    .nth(10)
    .evaluate((element) => element.click());
  await page.getByLabel("正在加载向量预览").waitFor({ state: "hidden" });
  check(
    "entering vector input starts at top",
    (await scroll().evaluate((element) => element.scrollTop)) === 0,
  );
  await back();
  check(
    "return restores record choice scroll offset",
    Math.abs((await scroll().evaluate((element) => element.scrollTop)) - offset) < 2,
  );
  await button("下一页").click();
  await action("open-vector-record").waitFor();
  check(
    "preview pagination reaches records beyond first twenty",
    (await page.locator('[data-action="open-vector-record"]').count()) === 5,
  );
  await openFirstRecord();
  check(
    "second page opens its own record",
    (await page.getByTestId("vector-preview-record-title").textContent()).includes("20"),
  );
  await back();
  await back();
  await label("配置来源").selectOption("custom");
  await button("新增分组").click();
  await label("分组名称").fill("草稿姓名");
  await label("分组 Key").fill("draft_name");
  await page.getByRole("checkbox", { name: "名称", exact: true }).click();
  const savedBefore = await page.evaluate(() =>
    JSON.stringify(window.frontendPreview.schemaSnapshot()),
  );
  await action("preview-vector-records").click();
  await openFirstRecord();
  check(
    "draft preview uses unsaved group and selection",
    (await page.locator("[data-vector-group]").textContent()).includes("草稿姓名") &&
      (await page.getByTestId("vector-preview-input").textContent()) === "名称：爱丽丝",
  );
  check(
    "draft preview never saves configuration",
    await page.evaluate(
      (before) => JSON.stringify(window.frontendPreview.schemaSnapshot()) === before,
      savedBefore,
    ),
  );
  await back();
  await back();
  check(
    "return retains dirty vector editor",
    (await label("分组名称").inputValue()) === "草稿姓名" &&
      (await page.evaluate(
        () => window.frontendPreview.tablesWorkspace.getSnapshot().editor.dirty,
      )),
  );
  await page.evaluate(() => {
    const workspace = window.frontendPreview.tablesWorkspace;
    const editor = workspace.getSnapshot().editor;
    workspace.change({
      ...editor,
      draft: {
        ...editor.draft,
        groups: [{ id: "broken", key: "broken", name: "失效分组", fieldIds: ["missing-field"] }],
      },
    });
  });
  await action("preview-vector-records").click();
  await openFirstRecord();
  check(
    "invalid draft field explains group failure",
    (await page.locator("[data-vector-group]").textContent()).includes("配置失效") &&
      (await page.locator("[data-vector-group]").textContent()).includes("missing-field"),
  );
  await page.getByLabel("预览对话", { exact: true }).selectOption("b");
  await page.waitForFunction(
    () => window.frontendPreview.tablesWorkspace.getSnapshot().context?.spaceId === "space-b",
  );
  check(
    "other conversation does not show prior vector preview",
    (await page.getByTestId("vector-preview-input").count()) === 0,
  );
  await page.getByLabel("预览对话", { exact: true }).selectOption("a");
  await page.getByTestId("vector-preview-input").waitFor();
  check(
    "returning chat restores its preview and draft",
    (await page.locator("[data-vector-group]").textContent()).includes("失效分组"),
  );
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/vector-preview-mobile-320.png` });
  check(
    "320px vector preview has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.reload();
  await openTable();
  await page.getByRole("button", { name: /向量索引/ }).click();
  await page.getByRole("switch", { name: "启用向量索引", exact: true }).click();
  await action("save-vector").click();
  await page.getByRole("button", { name: /向量索引/ }).click();
  await action("preview-vector-records").click();
  await openFirstRecord();
  check(
    "missing embedding connection is reported locally",
    (await page.locator("[data-vector-group]").textContent()).includes("连接不可用"),
  );
  await action("nav-settings").click();
  await button("Embedding 连接").click();
  await label("API Base URL").fill("https://preview.invalid/v1");
  await label("Embedding 模型").fill("preview-embedding");
  await action("save-changes").click();
  await page.getByText("向量连接已保存，新的索引请求会使用此配置。", { exact: true }).waitFor();
  await action("nav-tables").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.tablesWorkspace.getSnapshot().vectorPreview.groups[0]?.status ===
      "ready",
  );
  check(
    "returning from connection setup refreshes the same record preview",
    (await page.locator("[data-vector-group]").textContent()).includes("可生成") &&
      (await page.getByTestId("vector-preview-record-title").textContent()) === "爱丽丝",
  );
  await action("nav-settings").click();
  await button("Embedding 连接").click();
  await label("单条输入字符上限").fill("10");
  await action("save-changes").click();
  await page.getByText("向量连接已保存，新的索引请求会使用此配置。", { exact: true }).waitFor();
  await action("nav-tables").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.tablesWorkspace.getSnapshot().vectorPreview.groups[0]?.status ===
      "too_long",
  );
  check(
    "returning from connection limit change refreshes preview diagnostics",
    (await page.locator("[data-vector-group]").textContent()).includes("输入超长"),
  );
  await page.setViewportSize({ width: 320, height: 420 });
  await scroll().evaluate((element) => {
    element.scrollTop = 120;
  });
  await page.waitForTimeout(50);
  const previewOffset = await scroll().evaluate((element) => element.scrollTop);
  await action("close-frontend").click();
  await page.evaluate(() => window.frontendPreview.seedSearch());
  await button("打开预览").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      window.frontendPreview.tablesWorkspace.getSnapshot().vectorPreview.groups[0]?.status ===
        "ready" && !window.frontendPreview.tablesWorkspace.getSnapshot().vectorPreview.loading,
  );
  check(
    "reopening refreshes preview after external connection change",
    (await page.locator("[data-vector-group]").textContent()).includes("可生成"),
  );
  check(
    "refresh loading preserves preview scroll cache",
    await scroll().evaluate(
      (element, previous) =>
        Math.abs(
          element.scrollTop - Math.min(previous, element.scrollHeight - element.clientHeight),
        ) < 2,
      previewOffset,
    ),
  );
  check("no vector preview browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
