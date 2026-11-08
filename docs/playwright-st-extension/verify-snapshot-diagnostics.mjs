import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const screenshots = process.env.FRONTEND_SCREENSHOTS ?? "node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const url = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 320, height: 720 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const message = "聊天文件中的完整记忆元数据与本次提交不一致\n目标对话：char:3:bookshop\n操作：replacement\n首个差异：chat_metadata.steMemoryMirror.data.records[123].payload.field-name\n应保存：新名称\n文件回读：旧名称";
const notice = page.getByTestId("snapshot-save-notice");
const result = page.getByTestId("snapshot-sync-result");
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
async function checkCopy(container, http = false) {
  await page.evaluate(() => navigator.clipboard.writeText("待覆盖"));
  if (http) {
    await page.evaluate(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  }
  await container.getByRole("button", { name: /复制错误详情/ }).click();
  await container.getByRole("button", { name: "已复制错误详情", exact: true }).waitFor();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n").includes(message));
}
try {
  await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
  await action("nav-settings").click();
  await page.evaluate((message) => window.frontendPreview.showSaveFailure(message, "replacement"), message);
  await notice.waitFor();
  const text = await notice.innerText();
  for (const expected of ["目标对话：", "首个差异：", "应保存：新名称", "文件回读：旧名称"]) {
    assert.ok(text.includes(expected));
  }
  assert.equal(await notice.getByTestId("save-error-message").evaluate((element) => getComputedStyle(element).whiteSpace), "pre-wrap");
  await checkCopy(notice);
  await checkCopy(notice, true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const element of await page.getByTestId("save-error-details").all()) {
    assert.ok(await element.evaluate((node) => node.scrollWidth <= node.clientWidth));
  }
  await page.screenshot({ path: `${screenshots}/snapshot-diagnostics-mobile.png`, fullPage: true });
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await notice.waitFor({ state: "detached" });
  await page.evaluate((message) => window.frontendPreview.failNextForceSync(message), message);
  await action("force-sync-memory").click();
  await result.getByText(/文件回读：旧名称/).waitFor();
  await checkCopy(result);
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption("b");
  await page.waitForFunction(() => window.frontendPreview.workspace.getSnapshot().context?.chatKey.includes("harbour"));
  assert.equal(await result.count(), 0);
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption("a");
  await result.getByText(/文件回读：旧名称/).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${screenshots}/snapshot-diagnostics-desktop.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: detailed errors, exact clipboard copy, HTTP clipboard path, retry, chat isolation, and mobile/desktop layouts");
} finally {
  await browser.close();
}
