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
async function save() {
  await action("save-changes").click();
}
async function downloadJson() {
  const [download] = await Promise.all([page.waitForEvent("download"), button("导出草稿").click()]);
  const stream = await download.createReadStream();
  let value = "";
  for await (const chunk of stream) value += chunk.toString();
  return JSON.parse(value);
}
try {
  await page.goto(url);
  await action("nav-settings").click();
  await button("Agent 提示词预设").click();
  await action("open-agent-preset").click();
  check("builtin agent preset is read only", await field("预设名称").isDisabled());
  await button("复制为自定义").click();
  await field("预设名称").fill("提示词验收");
  await field("消息 1 内容").fill("保持事实一致。{{tablesDigest}}");
  await field("消息 2 角色").selectOption("user");
  await field("消息 2 名称").fill("剧情输入");
  await field("消息 2 内容").fill("待处理：{{msg}}");
  await button("上移消息 2").click();
  await save();
  await page.getByText("预设已保存。", { exact: true }).waitFor();
  let preset = (await settings()).agentPresets.presets.find((item) => item.name === "提示词验收");
  check(
    "agent message role order and content persist",
    preset.messages[0].role === "user" &&
      preset.messages[0].content === "待处理：{{msg}}" &&
      preset.messages[1].content.includes("tablesDigest"),
  );
  await field("预览剧情输入").fill("雨后的书店重新开门");
  await button("展开预览").click();
  await page.getByText("待处理：雨后的书店重新开门", { exact: true }).waitFor();
  check("preview expands unsent input without model request", true);
  const agentFile = await downloadJson();
  check(
    "agent export uses supported envelope",
    agentFile.format === "ste-memory-agent-preset" &&
      agentFile.version === 2 &&
      agentFile.preset.messages[0].role === "user",
  );
  await button("添加消息").click();
  await back();
  await button("保留编辑").click();
  check("dirty preset back retains new message", (await field("消息 3 内容").count()) === 1);
  await back();
  await button("放弃修改并继续").click();
  await field("活动预设").selectOption(preset.id);
  await page.waitForFunction(
    (id) => window.frontendPreview.settingsSnapshot().agentPresets.activePresetId === id,
    preset.id,
  );
  check(
    "active preset selection persists",
    (await settings()).agentPresets.activePresetId === preset.id,
  );
  await page.locator('[data-action="open-agent-preset"]').filter({ hasText: "提示词验收" }).click();
  await button("删除").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除预设", exact: true })
    .click();
  await action("create-agent-preset").waitFor();
  check(
    "deleting active agent preset restores builtin selection",
    (await settings()).agentPresets.activePresetId === "systemDefault" &&
      (await settings()).agentPresets.presets.length === 0,
  );
  await field("导入 Agent 预设 JSON").setInputFiles({
    name: "agent-preset.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(agentFile)),
  });
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().agentPresets.presets.length === 1,
  );
  check(
    "agent import creates and activates a fresh preset",
    (await settings()).agentPresets.presets[0].id !== preset.id &&
      (await settings()).agentPresets.activePresetId ===
        (await settings()).agentPresets.presets[0].id,
  );
  await back();

  await button("表格预设").click();
  await button("将当前表结构另存为预设").click();
  await field("预设名称").fill("当前空间结构");
  await field("预设说明").fill("移动端验收捕获");
  await save();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().tablePresets.userPresets.length === 1,
  );
  const tablePreset = (await settings()).tablePresets.userPresets[0];
  check(
    "capture saves structure without records",
    tablePreset.name === "当前空间结构" &&
      tablePreset.tables.length > 0 &&
      !Object.hasOwn(tablePreset, "records"),
  );
  await field("新空间默认预设").selectOption(tablePreset.id);
  await page.waitForFunction(
    (id) => window.frontendPreview.settingsSnapshot().tablePresets.defaultPresetId === id,
    tablePreset.id,
  );
  check(
    "new space default selection persists",
    (await settings()).tablePresets.defaultPresetId === tablePreset.id,
  );
  await page
    .locator('[data-action="open-table-preset"]')
    .filter({ hasText: "当前空间结构" })
    .click();
  await field("跨表填写规则").fill("合并跨表上下文后填写。");
  check("dirty table preset cannot apply", await button("应用到当前空间").isDisabled());
  await save();
  await page.getByText("预设已保存，不影响已有空间。", { exact: true }).waitFor();
  check(
    "table preset rules save independently of existing space",
    (await settings()).tablePresets.userPresets[0].prompt === "合并跨表上下文后填写。",
  );
  const tableFile = await downloadJson();
  check(
    "table export includes schema but excludes records",
    tableFile.format === "ste-memory-table-preset" &&
      tableFile.version === 3 &&
      tableFile.preset.tables.length === tablePreset.tables.length &&
      !Object.hasOwn(tableFile.preset, "records"),
  );
  await back();
  await field("导入表格预设 JSON").setInputFiles({
    name: "table-preset.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(tableFile)),
  });
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().tablePresets.userPresets.length === 2,
  );
  check(
    "table import resolves duplicate names and keeps default",
    (await settings()).tablePresets.userPresets[1].name === "当前空间结构 (2)" &&
      (await settings()).tablePresets.defaultPresetId === tablePreset.id,
  );
  await page
    .locator('[data-action="open-table-preset"]')
    .filter({ hasText: "当前空间结构 (2)" })
    .click();
  await button("复制为用户预设").click();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().tablePresets.userPresets.length === 3,
  );
  check(
    "table copy retains rules",
    (await settings()).tablePresets.userPresets[2].prompt === "合并跨表上下文后填写。",
  );
  await page
    .locator('[data-action="open-table-preset"]')
    .filter({ hasText: "当前空间结构" })
    .first()
    .click();
  await button("删除预设").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除预设", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.settingsSnapshot().tablePresets.defaultPresetId === "systemDefault",
  );
  check(
    "deleting default table preset restores system default",
    (await settings()).tablePresets.userPresets.length === 2,
  );
  await action("open-table-preset").click();
  await button("应用到当前空间").click();
  check(
    "apply confirms the destructive scope",
    (await page
      .getByRole("alertdialog")
      .getByText(/全部记录、历史、证据/)
      .count()) === 1,
  );
  const beforeCancel = await schema();
  await page.evaluate(() => window.frontendPreview.cancelPresetBackup(true));
  await button("备份并应用").click();
  await page.getByText("备份已取消，未应用预设。", { exact: true }).waitFor();
  check(
    "cancelled backup prevents apply",
    JSON.stringify(await schema()) === JSON.stringify(beforeCancel),
  );
  await page.evaluate(() => window.frontendPreview.switchChat("b"));
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  check("chat switch dismisses stale apply confirmation", true);
  await page.evaluate(() => window.frontendPreview.cancelPresetBackup(false));
  await button("应用到当前空间").click();
  await button("备份并应用").click();
  await page.getByText(/已按「系统默认」重建/).waitFor();
  const afterApply = await schema();
  await page.locator('[data-slot="alert-dialog-content"]').waitFor({ state: "detached" });
  check(
    "apply rebuilds only the confirmed space",
    afterApply.tables.filter((item) => item.memorySpaceId === "space-b").length > 3 &&
      afterApply.tables.filter((item) => item.memorySpaceId === "space-a").length ===
        beforeCancel.tables.filter((item) => item.memorySpaceId === "space-a").length,
  );
  await page.setViewportSize({ width: 320, height: 720 });
  check(
    "320px table preset has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.screenshot({ path: `${screenshots}/settings-table-preset-320.png` });
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
