import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 320, height: 640 },
  acceptDownloads: true,
});
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
const records = () => page.evaluate(() => window.frontendPreview.snapshot());
const schema = () => page.evaluate(() => window.frontendPreview.schemaSnapshot());
const preview = () => page.getByTestId("backup-preview");
async function upload(text, name = "backup.json") {
  await label("选择备份 JSON").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
}
async function switchChat(key) {
  await label("预览对话").selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.workspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour"),
    key,
  );
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-settings").click();
  check("settings has no snapshot sync toggle", (await label("同步到对话文件").count()) === 0);
  await page.evaluate(() => window.frontendPreview.showSaveFailure());
  await page.getByText("已提交、未保存：preview file failure", { exact: false }).waitFor();
  await switchChat("b");
  check("other chat hides an unrelated file error", (await button("重试保存").count()) === 0);
  check(
    "pending original chat still protects refresh",
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  await switchChat("a");
  await button("重试保存").waitFor();
  await button("重试保存").click();
  check(
    "settings retries the pending snapshot",
    (await page.getByRole("button", { name: "重试保存", exact: true }).count()) === 0,
  );
  await button("备份与空间维护").click();
  check(
    "maintenance has no full-library or optional-history controls",
    (await label("导出范围").count()) === 0 &&
      (await label("恢复范围").count()) === 0 &&
      (await label("包含修订历史").count()) === 0,
  );
  const currentDownload = page.waitForEvent("download");
  await button("导出 JSON 文件").click();
  const currentFile = await currentDownload;
  const currentText = await readFile(await currentFile.path(), "utf8");
  check(
    "current export includes only current space",
    JSON.parse(currentText).data.spaces.length === 1 &&
      JSON.parse(currentText).data.spaces[0].space.id === "space-a",
  );
  const original = JSON.stringify(await records());
  await upload("{not json}", "invalid.json");
  await page.getByRole("alert").first().waitFor();
  check(
    "invalid backup never writes or previews",
    JSON.stringify(await records()) === original && (await preview().count()) === 0,
  );
  await upload(currentText);
  await preview().waitFor();
  check("backup upload only prepares preview", JSON.stringify(await records()) === original);
  await button("确认导入此文件").click();
  await button("取消").click();
  check(
    "cancel restore does not write",
    JSON.stringify(await records()) === original && (await preview().count()) === 1,
  );
  await switchChat("b");
  await preview().waitFor({ state: "hidden" });
  check("chat switch invalidates prepared restore", (await button("确认导入此文件").count()) === 0);
  await switchChat("a");
  const multiple = JSON.parse(currentText);
  multiple.data.spaces.push({
    ...multiple.data.spaces[0],
    space: { ...multiple.data.spaces[0].space, id: "another-space" },
    tables: [],
    fields: [],
    records: [],
    evidence: [],
    history: [],
  });
  await upload(JSON.stringify(multiple));
  await page.getByText("导入文件必须只包含一个记忆空间", { exact: true }).waitFor();
  check("multi-space file is explicitly rejected", (await preview().count()) === 0);
  await upload(currentText);
  await preview().waitFor();
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/settings-maintenance-320.png` });
  await button("确认导入此文件").click();
  await button("执行导入").click();
  await preview().waitFor({ state: "hidden" });
  check(
    "confirmed restore completes without reusable preview",
    (await button("确认导入此文件").count()) === 0,
  );
  await switchChat("b");
  const beforeClear = await records();
  const beforeTables = (await schema()).tables;
  await button("清除当前空间记录").click();
  await button("取消").click();
  check(
    "cancel record clear preserves all records",
    JSON.stringify(await records()) === JSON.stringify(beforeClear),
  );
  await button("清除当前空间记录").click();
  await button("确认清除记录").click();
  await page.waitForFunction(
    () => !window.frontendPreview.snapshot().some((record) => record.memorySpaceId === "space-b"),
  );
  const afterClear = await records();
  check(
    "confirmed clear targets only selected space",
    afterClear.some((record) => record.memorySpaceId === "space-a") &&
      !afterClear.some((record) => record.memorySpaceId === "space-b"),
  );
  check(
    "record clear retains table structure",
    JSON.stringify((await schema()).tables) === JSON.stringify(beforeTables),
  );
  check(
    "320px maintenance has no horizontal overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  check("no maintenance browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
