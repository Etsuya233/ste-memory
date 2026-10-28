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
  await button("备份与空间维护").click();
  await label("导出范围").selectOption("all");
  const allDownload = page.waitForEvent("download");
  await button("导出 JSON 文件").click();
  const allFile = await allDownload;
  const allText = await readFile(await allFile.path(), "utf8");
  const decoded = JSON.parse(allText);
  check(
    "full export downloads backup envelope",
    decoded.format === "ste-memory-backup" && decoded.data.spaces.length === 2,
  );
  await label("导出范围").selectOption("current");
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
  await button("确认恢复此文件").click();
  await button("取消").click();
  check(
    "cancel restore does not write",
    JSON.stringify(await records()) === original && (await preview().count()) === 1,
  );
  await switchChat("b");
  await preview().waitFor({ state: "hidden" });
  check("chat switch invalidates prepared restore", (await button("确认恢复此文件").count()) === 0);
  await switchChat("a");
  await label("恢复范围").selectOption("all");
  await upload(allText);
  await preview().waitFor();
  check(
    "full restore preview reports data scope",
    (await preview().textContent()).includes("2 个空间"),
  );
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/settings-maintenance-320.png` });
  await button("确认恢复此文件").click();
  await button("执行恢复").click();
  await preview().waitFor({ state: "hidden" });
  check(
    "confirmed restore completes without reusable preview",
    (await button("确认恢复此文件").count()) === 0,
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
