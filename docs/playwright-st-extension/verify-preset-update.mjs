import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const field = (name) => page.getByLabel(name, { exact: true });
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const schema = () => page.evaluate(() => window.frontendPreview.schemaSnapshot());
const records = () =>
  page.evaluate(() => window.frontendPreview.snapshot().sort((a, b) => a.id.localeCompare(b.id)));
const metrics = () => page.evaluate(() => window.frontendPreview.presetUpdateState());
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const back = () => action("page-back").click();
async function compare() {
  await action("compare-preset-update").click();
  await page.getByRole("combobox", { name: "差异筛选", exact: true }).waitFor();
}
async function switchChat(value) {
  await field("预览对话").selectOption(value);
  await page.waitForFunction(
    (value) => window.frontendPreview.workspace.getSnapshot().context?.spaceId === `space-${value}`,
    value,
  );
}
async function openTable(name) {
  await page
    .locator('[data-action="open-preset-structure-table"]')
    .filter({ hasText: name })
    .click();
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-settings").click();
  await button("表格预设").click();
  await button("将当前表结构另存为预设").click();
  await field("预设名称").fill("增量验收");
  await action("save-changes").click();
  await page.locator('[data-action="open-table-preset"]').filter({ hasText: "增量验收" }).click();
  await field("预设名称").fill("未保存的增量预设");
  check(
    "dirty preset cannot compare or apply incremental updates",
    await action("open-preset-update").isDisabled(),
  );
  await field("预设名称").fill("增量验收");
  await field("跨表填写规则").fill("保留现有记忆，只更新勾选项");
  await button("编辑表格与字段结构").click();
  await openTable("人物");
  await page.getByRole("button", { name: /名称 · name · short_text/ }).click();
  await field("名称").fill("人物名称");
  await button("完成编辑").click();
  await page.getByRole("button", { name: /描述 · notes · long_text/ }).click();
  await field("类型").selectOption("integer");
  await button("完成编辑").click();
  await button("新增字段").click();
  await field("名称").fill("别名");
  await field("Key").fill("alias");
  await button("完成编辑").click();
  await back();
  await openTable("纪要");
  await button("删除预设表格").click();
  await button("删除草稿项").click();
  await button("返回预设").click();
  await action("save-changes").click();
  await page.getByText("预设已保存，不影响已有空间。", { exact: true }).waitFor();
  const beforeSchema = await schema(),
    beforeRecords = JSON.stringify(await records());
  check(
    "editing the source preset leaves the space unchanged",
    beforeSchema.tables.length === 6 && beforeSchema.fields.some((field) => field.name === "名称"),
  );
  await action("open-preset-update").scrollIntoViewIfNeeded();
  const detailScroll = page.locator("#settings-table-preset").locator("..");
  const previousTop = await detailScroll.evaluate((el) => el.scrollTop);
  await action("open-preset-update").click();
  await compare();
  check(
    "comparison does not mutate current records",
    JSON.stringify(await records()) === beforeRecords,
  );
  check(
    "type differences explicitly retain the current field type",
    (await page
      .getByText("类型不同：long_text → integer；保留当前类型", { exact: true })
      .count()) === 1,
  );
  await button("选择全部更新").click();
  check(
    "updates selection leaves creates and deletes unselected",
    (await page.getByRole("checkbox", { name: "选择 别名 · alias", exact: true }).isChecked()) ===
      false &&
      (await page
        .getByRole("checkbox", { name: "选择 纪要 · table_2", exact: true })
        .isChecked()) === false,
  );
  const parentChoice = page.getByRole("checkbox", { name: "选择 人物 · table_0", exact: true });
  const mixed = await parentChoice.getAttribute("aria-checked");
  await parentChoice.click();
  check(
    "mixed parent selection toggles all descendant changes",
    mixed === "mixed" &&
      (await parentChoice.isChecked()) &&
      (await page.getByRole("checkbox", { name: "选择 别名 · alias", exact: true }).isChecked()),
  );
  await button("清空选择").click();
  await button("选择全部更新").click();
  await field("差异筛选").selectOption("selected");
  check(
    "selected filter hides unselected deletion",
    (await page.getByRole("checkbox", { name: "选择 纪要 · table_2", exact: true }).count()) === 0,
  );
  await field("差异筛选").selectOption("all");
  await action("confirm-preset-update").click();
  check(
    "confirmation focuses cancellation",
    await button("取消").evaluate((el) => document.activeElement === el),
  );
  const beforeApply = (await metrics()).applies;
  await page.evaluate(() => window.frontendPreview.cancelPresetBackup(true));
  await button("备份并执行").click();
  await page.getByText("备份未完成，未执行所选变更。", { exact: true }).last().waitFor();
  check("cancelled backup never invokes update apply", (await metrics()).applies === beforeApply);
  await page.evaluate(() => window.frontendPreview.cancelPresetBackup(false));
  await button("取消").click();
  await page.evaluate(() => window.frontendPreview.failNextPresetUpdateSync());
  await page.evaluate(() => window.frontendPreview.delayPresetUpdateResult(500));
  const beforeDelayedApply = (await metrics()).applies;
  await action("confirm-preset-update").click();
  await button("直接执行").click();
  await page.waitForFunction(
    (count) => window.frontendPreview.presetUpdateState().applies > count,
    beforeDelayedApply,
  );
  await switchChat("b");
  check(
    "pending committed update cannot be navigated away",
    await action("page-back").isDisabled(),
  );
  await page.waitForTimeout(600);
  check(
    "committed warning stays hidden in another chat",
    (await page.getByTestId("preset-update-result").count()) === 0,
  );
  await switchChat("a");
  await page.getByTestId("preset-update-result").waitFor();
  const partial = await schema();
  check(
    "selected metadata updates preserve unselected structure and records",
    partial.fields.some(
      (field) =>
        field.tableId === "space-a-table-0" && field.key === "name" && field.name === "人物名称",
    ) &&
      partial.fields.some(
        (field) =>
          field.tableId === "space-a-table-0" &&
          field.key === "notes" &&
          field.type === "long_text",
      ) &&
      !partial.fields.some((field) => field.key === "alias") &&
      partial.tables.some((table) => table.id === "space-a-table-2") &&
      JSON.stringify(await records()) === beforeRecords,
  );
  check(
    "committed warning removes the reusable mutation plan",
    (await action("confirm-preset-update").count()) === 0 &&
      (await button("重试保存与索引核对").isVisible()),
  );
  const committed = (await metrics()).applies;
  await button("重试保存与索引核对").click();
  await page.getByText("所选变更已提交，保存和索引核对已完成。", { exact: true }).waitFor();
  check(
    "retry only saves and reconciles without replaying mutations",
    (await metrics()).applies === committed && (await metrics()).retries === 1,
  );
  await compare();
  await button("选择全部新增").click();
  await page.evaluate(() => window.frontendPreview.changeRecord());
  const staleBefore = JSON.stringify(await schema());
  await action("confirm-preset-update").click();
  await button("直接执行").click();
  await page.getByText("空间内容已变化，请重新比较后执行", { exact: true }).last().waitFor();
  check(
    "stale comparison is rejected without modifying schema",
    JSON.stringify(await schema()) === staleBefore,
  );
  await button("取消").click();
  await compare();
  await button("选择全部新增").click();
  await page.getByRole("checkbox", { name: "选择 纪要 · table_2", exact: true }).click();
  await action("confirm-preset-update").click();
  check(
    "destructive selection names the deleted table",
    (await page.getByRole("alertdialog").textContent()).includes("table_2（含整表记录与历史）"),
  );
  await switchChat("b");
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  check(
    "external chat switch invalidates confirmation",
    (await action("confirm-preset-update").count()) === 0,
  );
  await switchChat("a");
  await compare();
  await button("选择全部新增").click();
  await page.getByRole("checkbox", { name: "选择 纪要 · table_2", exact: true }).click();
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/preset-update-320.png` });
  await action("confirm-preset-update").click();
  const beforeAbaApply = (await metrics()).applies;
  await page.evaluate(() => {
    window.frontendPreview.delayPresetUpdate(500);
    window.frontendPreview.failNextPresetUpdateSync();
  });
  await button("直接执行").click();
  await switchChat("b");
  await switchChat("a");
  await page.getByTestId("preset-update-result").waitFor();
  check(
    "A to B to A retains committed warnings without reopening mutation plan",
    (await metrics()).applies === beforeAbaApply + 1 &&
      (await action("confirm-preset-update").count()) === 0 &&
      (await button("重试保存与索引核对").isVisible()),
  );
  await button("重试保存与索引核对").click();
  await page.getByText("所选变更已提交，保存和索引核对已完成。", { exact: true }).waitFor();
  const final = await schema();
  check(
    "selected create and delete apply only to the confirmed space",
    final.fields.some((field) => field.memorySpaceId === "space-a" && field.key === "alias") &&
      !final.tables.some((table) => table.id === "space-a-table-2") &&
      final.tables.filter((table) => table.memorySpaceId === "space-b").length === 3,
  );
  await compare();
  await page.getByText("没有可执行的变更", { exact: true }).waitFor();
  check(
    "non actionable type differences have no mutation action",
    (await action("confirm-preset-update").count()) === 0 &&
      (await button("选择全部更新").isDisabled()) &&
      (await button("选择全部新增").isDisabled()),
  );
  await page.evaluate(() => window.frontendPreview.delayPresetCompare(450));
  await action("compare-preset-update").click();
  await switchChat("b");
  await switchChat("a");
  await page.waitForTimeout(550);
  check("A to B to A rejects obsolete comparison results", (await field("差异筛选").count()) === 0);
  check(
    "320px incremental page has no horizontal overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await back();
  check(
    "return restores preset detail scroll",
    Math.abs((await detailScroll.evaluate((el) => el.scrollTop)) - previousTop) <= 1,
  );
  check("no incremental update browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
