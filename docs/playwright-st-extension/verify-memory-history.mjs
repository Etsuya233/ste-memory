import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
page.setDefaultTimeout(10_000);
const button = (name) => page.getByRole("button", { name, exact: true });
const list = page.getByRole("list").filter({ has: page.getByText("版本详情", { exact: true }) });
const item = (name) => list.getByRole("listitem").filter({ hasText: name });
const name = page.getByRole("textbox", { name: "版本名称（可选）" });
const chat = page.getByLabel("预览对话");
const dialog = page.getByRole("alertdialog");

try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await page.locator('[data-action="nav-settings"]:visible').first().click();
  await button("备份与空间维护").click();
  await button("历史版本").click();
  await page.getByText("暂无历史版本", { exact: true }).waitFor();
  await button("保存版本").click();
  await name.fill("测试版本");
  await button("保存").click();
  await item("测试版本").waitFor();
  await item("测试版本").getByText("版本详情", { exact: true }).click();
  await item("测试版本").getByText("未跟踪", { exact: true }).waitFor();
  await item("测试版本")
    .getByText(/gzip.*原始/)
    .waitFor();
  console.log("PASS 手动保存、压缩大小及楼层详情");

  await item("测试版本").getByRole("button", { name: "改名" }).click();
  await page.getByRole("textbox", { name: "版本名称", exact: true }).fill("测试/旧稿");
  await button("保存").click();
  await item("测试/旧稿").waitFor();
  const pendingDownload = page.waitForEvent("download");
  await item("测试/旧稿").getByRole("button", { name: "导出" }).click();
  const download = await pendingDownload;
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.match(download.suggestedFilename(), /测试-旧稿.*\.json$/u);
  assert.equal(backup.format, "ste-memory-backup");
  assert.equal(backup.data.spaces.length, 1);
  assert.ok(backup.data.spaces[0].records.length);
  console.log("PASS 改名及现有 JSON 格式导出");

  await item("测试/旧稿").getByRole("button", { name: "恢复" }).click();
  await dialog.waitFor();
  await chat.selectOption("b");
  await page.getByText("暂无历史版本", { exact: true }).waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal(await item("测试/旧稿").count(), 0);
  await chat.selectOption("a");
  await item("测试/旧稿").waitFor();
  console.log("PASS 切聊隔离及旧恢复确认失效");

  await item("测试/旧稿").getByRole("button", { name: "恢复" }).click();
  await dialog.getByText(/任务、向量及 Agent 会话/).waitFor();
  await dialog.getByRole("button", { name: "确认恢复" }).click();
  await item("恢复前保存").waitFor();
  assert.equal(await item("测试/旧稿").count(), 1);
  console.log("PASS 恢复前备份及手动版本保留");

  await item("测试/旧稿").getByRole("button", { name: "删除" }).click();
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.equal(await item("测试/旧稿").count(), 1);
  await item("测试/旧稿").getByRole("button", { name: "删除" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await item("测试/旧稿").waitFor({ state: "hidden" });
  console.log("PASS 删除确认及取消");

  await button("自动保存设置").click();
  const interval = page.getByLabel("保存间隔（层）");
  const limit = page.getByLabel("每个对话保留的自动版本（份）");
  const enabled = page.getByRole("switch", { name: "填表成功后自动保存版本" });
  assert.equal(await interval.inputValue(), "10");
  assert.equal(await limit.inputValue(), "20");
  assert.equal(await enabled.getAttribute("aria-checked"), "true");
  await enabled.click();
  await interval.fill("4");
  await limit.fill("1");
  await page.evaluate(() => window.frontendPreview.failNextHistoryTrim());
  await button("保存").click();
  await page.getByText(/设置已保存，后续处理失败.*历史版本清理失败/).waitFor();
  await button("返回").click();
  await button("自动保存设置").click();
  await button("重试历史清理").click();
  await page.getByText("历史版本清理完成。", { exact: true }).waitFor();
  assert.equal(await button("重试历史清理").count(), 0);
  assert.equal(await interval.inputValue(), "4");
  assert.equal(await limit.inputValue(), "1");
  assert.equal(await enabled.getAttribute("aria-checked"), "false");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1120, height: 800 });
  await button("返回").click();
  await item("恢复前保存").waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS 自动保存设置、重试清理、窄屏与桌面布局");
} finally {
  await browser.close();
}
