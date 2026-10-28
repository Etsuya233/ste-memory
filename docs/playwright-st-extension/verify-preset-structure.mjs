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
const button = (name) => page.getByRole("button", { name, exact: true });
const field = (name) => page.getByLabel(name, { exact: true });
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const settings = () => page.evaluate(() => window.frontendPreview.settingsSnapshot());
const schema = () => page.evaluate(() => window.frontendPreview.schemaSnapshot());
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function back() {
  await action("page-back").click();
}
async function done() {
  await button("完成编辑").click();
}
async function openTable(name) {
  await page
    .locator('[data-action="open-preset-structure-table"]')
    .filter({ hasText: name })
    .click();
}
try {
  await page.goto(url);
  await action("nav-settings").click();
  await button("表格预设").click();
  await button("将当前表结构另存为预设").click();
  await field("预设名称").fill("结构深度验收");
  await action("save-changes").click();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().tablePresets.userPresets.length === 1,
  );
  await page
    .locator('[data-action="open-table-preset"]')
    .filter({ hasText: "结构深度验收" })
    .click();
  await button("编辑表格与字段结构").click();
  await openTable("人物");
  await button("编辑向量分组").click();
  await page.getByRole("switch", { name: "启用向量索引", exact: true }).click();
  await button("新增分组").click();
  await field("分组名称").fill("人物信息");
  await field("分组 Key").fill("people_info");
  await page.getByRole("checkbox", { name: "名称", exact: true }).click();
  await page.getByRole("checkbox", { name: "描述", exact: true }).click();
  await done();
  await page.getByRole("button", { name: /描述 · notes · long_text/ }).click();
  check("preset field type stays editable", !(await field("类型").isDisabled()));
  await field("Key").fill("notes_ext");
  await field("字符数上限").fill("500");
  await field("格式校验正则").fill("^[\\s\\S]+$");
  await done();
  check(
    "structure edits remain unsaved drafts",
    !(await settings()).tablePresets.userPresets[0].tables[0].vectorIndex &&
      (await settings()).tablePresets.userPresets[0].tables[0].fields.some(
        (item) => item.key === "notes",
      ),
  );
  await button("下移字段 描述").click();
  await back();
  await button("下移表格 人物").click();
  await openTable("地点");
  await button("编辑表格属性").click();
  await field("Key").fill("places_renamed");
  await done();
  await button("编辑向量分组").click();
  await page.getByRole("switch", { name: "启用向量索引", exact: true }).click();
  await button("新增分组").click();
  await field("分组名称").fill("名称摘要");
  await field("分组 Key").fill("name_summary");
  await page.getByRole("checkbox", { name: "名称", exact: true }).click();
  await done();
  await back();
  await button("新增表格").click();
  await field("名称").fill("草稿表");
  await field("Key").fill("draft_table");
  await done();
  await button("新增字段").click();
  await field("名称").fill("可选状态");
  await field("Key").fill("state");
  await field("类型").selectOption("single_select");
  await field("固定选项（每行一个）").fill("等待\n完成");
  await done();
  await button("新增字段").click();
  await field("名称").fill("应被放弃");
  await back();
  await button("保留编辑").click();
  check(
    "unfinished structure form has local leave protection",
    (await field("名称").inputValue()) === "应被放弃",
  );
  await back();
  await button("放弃修改并继续").click();
  await button("删除预设字段 可选状态").click();
  await button("删除草稿项").click();
  await page.getByText("尚无字段", { exact: true }).waitFor();
  check(
    "deleting a draft field updates only the draft",
    (await settings()).tablePresets.userPresets[0].tables.length === 3,
  );
  await button("删除预设表格").click();
  await button("删除草稿项").click();
  await button("返回预设").click();
  await action("save-changes").click();
  await page.getByText("预设已保存，不影响已有空间。", { exact: true }).waitFor();
  const preset = (await settings()).tablePresets.userPresets[0];
  const people = preset.tables.find((item) => item.key === "table_0");
  check(
    "table and field sorting persist",
    preset.tables[0].key === "places_renamed" && people.fields[2].key === "notes_ext",
  );
  check(
    "field constraints and vector key references follow rename",
    people.fields.find((item) => item.key === "notes_ext").maxChars === 500 &&
      people.vectorIndex.groups[0].fieldKeys.join(",") === "name,notes_ext",
  );
  check(
    "cross table references follow table key rename",
    people.fields.find((item) => item.key === "place").referenceTableKey === "places_renamed",
  );
  check(
    "preset edits never alter current space",
    (await schema()).fields.some(
      (item) => item.tableId === "space-a-table-0" && item.key === "notes",
    ) && !(await schema()).tables.some((item) => item.key === "places_renamed"),
  );
  await back();
  await back();
  await action("nav-tables").click();
  await page.locator('[data-action="open-table"]').filter({ hasText: "人物" }).click();
  await page.getByRole("button", { name: /向量索引/ }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  check(
    "320px schema page has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.screenshot({ path: `${screenshots}/tables-vector-mobile-320.png` });
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
