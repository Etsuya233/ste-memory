import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
const errors = [];
page.on("pageerror", (cause) => errors.push(cause.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () =>
  page.evaluate(() => {
    const value = window.frontendPreview.workspace.getSnapshot();
    return {
      order: value.order,
      page: value.page,
      search: value.search,
      records: value.records?.records,
      tableId: value.tableId,
    };
  });
const rows = () =>
  page
    .locator('[data-action="open-record"]:visible')
    .evaluateAll((elements) => elements.map((element) => element.dataset.recordId));
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function settled() {
  await page.waitForFunction(() => !window.frontendPreview.workspace.getSnapshot().listLoading);
}
async function sort(fieldId, direction) {
  await action("record-sort").click();
  await page.locator(`[data-sort-field="${fieldId}"]:visible`).click();
  await page.waitForFunction(
    ({ fieldId, direction }) => {
      const value = window.frontendPreview.workspace.getSnapshot();
      return (
        !value.listLoading && value.order.fieldId === fieldId && value.order.direction === direction
      );
    },
    { fieldId, direction },
  );
  await page.locator('[data-slot="dropdown-menu-content"]:visible').waitFor({ state: "hidden" });
}
async function next() {
  await button("下一页").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.workspace.getSnapshot().page === 2 &&
      !window.frontendPreview.workspace.getSnapshot().listLoading,
  );
}
async function switchChat(key) {
  await page.getByLabel("预览对话", { exact: true }).selectOption(key);
  await page.waitForFunction((key) => {
    const value = window.frontendPreview.workspace.getSnapshot();
    return value.context?.spaceId === `space-${key}` && !value.listLoading;
  }, key);
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("record-sort").waitFor();
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (
        key.startsWith("ste-memory:record-sort:v1:") &&
        (key.includes('"space-a"') || key.includes('"space-b"'))
      )
        localStorage.removeItem(key);
  });
  await page.reload();
  await action("open-record").waitFor();
  check(
    "default created order uses the first full-set page",
    (await rows())[0] === "space-a-record-0" && (await rows()).length === 20,
  );
  await next();
  await sort("$created_at", "desc");
  check(
    "same field toggles direction and returns to page one",
    (await state()).page === 1 && (await rows())[0] === "space-a-record-24",
  );
  await sort("$created_at", "asc");
  check("repeat current choice restores ascending", (await rows())[0] === "space-a-record-0");
  await sort("$updated_at", "asc");
  check("updated time has its own ascending order", (await rows())[0] === "space-a-record-24");
  await sort("$updated_at", "desc");
  check(
    "updated time descending is explicit",
    (await rows())[0] === "space-a-record-0" &&
      (await action("record-sort").getAttribute("aria-label")).includes("降序"),
  );
  await action("record-sort").click();
  check(
    "lists and references are excluded",
    (await page.locator('[data-sort-field="tags"]').count()) === 0 &&
      (await page.locator('[data-sort-field="place"]').count()) === 0,
  );
  await page.keyboard.press("Escape");
  await sort("count", "asc");
  check("numeric sort applies before paging", (await rows())[0] === "space-a-record-1");
  await next();
  check("empty numeric values stay last ascending", (await rows()).at(-1) === "space-a-record-24");
  await sort("count", "desc");
  check(
    "descending uses the full matching set",
    (await state()).page === 1 && (await rows())[0] === "space-a-record-23",
  );
  await next();
  const second = await rows();
  check(
    "empty values stay last descending and ties use stable ids",
    second.at(-1) === "space-a-record-24" &&
      second.indexOf("space-a-record-0") < second.indexOf("space-a-record-3"),
  );
  await page.getByLabel("搜索记录", { exact: true }).fill("旅人");
  await page.waitForFunction(() => {
    const value = window.frontendPreview.workspace.getSnapshot();
    return value.search === "旅人" && !value.listLoading;
  });
  check(
    "search uses the selected order and resets page",
    (await state()).page === 1 &&
      (await state()).order.fieldId === "count" &&
      (await rows())[0] === "space-a-record-23",
  );
  await page.getByLabel("记忆表格", { exact: true }).selectOption("space-a-table-1");
  await settled();
  check("each table has an independent sort", (await state()).order.fieldId === "$created_at");
  await sort("$updated_at", "asc");
  await page.getByLabel("记忆表格", { exact: true }).selectOption("space-a-table-0");
  await settled();
  check(
    "returning to table restores its preference",
    (await state()).order.fieldId === "count" && (await state()).order.direction === "desc",
  );
  await switchChat("b");
  check(
    "another space starts with its own default",
    (await state()).order.fieldId === "$created_at",
  );
  await sort("$updated_at", "asc");
  await switchChat("a");
  check(
    "A to B to A restores the original space choice",
    (await state()).order.fieldId === "count" && (await state()).order.direction === "desc",
  );
  await page.reload();
  await action("open-record").waitFor();
  check(
    "reload restores browser preference",
    (await state()).order.fieldId === "count" &&
      (await state()).order.direction === "desc" &&
      (await rows())[0] === "space-a-record-23",
  );
  await action("open-record").click();
  await action("edit-record").click();
  const textInput = page.locator('form input[type="text"]').first();
  await textInput.fill("未保存排序测试");
  await action("nav-tables").click();
  await button("保留编辑").click();
  check(
    "sorting keeps the existing dirty-editor navigation guard",
    await action("save-record").isVisible(),
  );
  await action("cancel-edit").click();
  await button("放弃修改并继续").click();
  await action("back-to-records").click();
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await action("record-sort").click();
  await page.screenshot({ path: `${directory}/record-sorting-320.png` });
  check(
    "320px sort menu and list avoid horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await sort("$created_at", "asc");
  check(
    "desktop keeps the same sort interaction",
    (await state()).order.fieldId === "$created_at" && (await rows())[0] === "space-a-record-0",
  );
  await sort("count", "asc");
  await page.evaluate(() => window.frontendPreview.removeSortingField("count"));
  await settled();
  check(
    "deleted sort field resets the saved choice and page",
    (await state()).order.fieldId === "$created_at" &&
      (await state()).page === 1 &&
      (await rows())[0] === "space-a-record-0",
  );
  await page.reload();
  await action("open-record").waitFor();
  check(
    "removed field preference does not return on reload",
    (await state()).order.fieldId === "$created_at",
  );
  check("no sorting browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
