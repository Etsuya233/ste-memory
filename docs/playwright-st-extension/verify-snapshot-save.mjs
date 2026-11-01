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
const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const control = page.getByTestId("snapshot-sync-control");
const result = page.getByTestId("snapshot-sync-result");
const forceSync = action("force-sync-memory");
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function switchChat(key) {
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.workspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour"),
    key,
  );
}
async function waitForResult(text) {
  await result.getByText(text, { exact: false }).waitFor();
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("open-record").waitFor();
  check(
    "records have no permanent sync bar or action",
    (await forceSync.count()) === 0 &&
      (await page.getByText(/已交给 ST 保存 · 未核验/).count()) === 0,
  );
  await action("nav-settings").click();
  check("force sync is available in settings", await forceSync.isEnabled());
  const original = await page.evaluate(() => ({
    records: window.frontendPreview.snapshot(),
    timeout: window.frontendPreview.settingsSnapshot().fillAgentTimeoutSeconds,
  }));
  const timeout = page.getByLabel("每批填写 Agent 超时（秒）", { exact: true });
  await timeout.fill("601");
  await page.evaluate(() => window.frontendPreview.delayNextForceSync(400));
  await forceSync.click();
  await waitForResult("正在同步");
  check("force sync prevents duplicate clicks", await forceSync.isDisabled());
  await waitForResult("同步完成");
  check(
    "one click starts one sync",
    (await page.evaluate(() => window.frontendPreview.forceSyncCalls())) === 1,
  );
  check("force sync preserves unsubmitted form values", (await timeout.inputValue()) === "601");
  check(
    "force sync never submits form drafts",
    JSON.stringify(
      await page.evaluate(() => ({
        records: window.frontendPreview.snapshot(),
        timeout: window.frontendPreview.settingsSnapshot().fillAgentTimeoutSeconds,
      })),
    ) === JSON.stringify(original),
  );
  await page.screenshot({ path: `${screenshots}/snapshot-sync-320.png`, fullPage: true });
  await page.evaluate(() =>
    window.frontendPreview.failNextForceSync("远端快照与当前已提交记忆不一致"),
  );
  await forceSync.click();
  await waitForResult("同步失败：远端快照与当前已提交记忆不一致");
  check(
    "failed verification never shows sync complete",
    !(await control.textContent()).includes("同步完成"),
  );
  await forceSync.click();
  await waitForResult("同步完成");
  check(
    "retry uses the same force-sync ability",
    (await page.evaluate(() => window.frontendPreview.forceSyncCalls())) === 3,
  );
  await page.evaluate(() => window.frontendPreview.delayNextForceSync(700));
  await forceSync.click();
  await switchChat("b");
  await page.waitForTimeout(800);
  check("late result from A cannot confirm B", (await result.count()) === 0);
  await switchChat("a");
  check("A to B to A cannot revive the old sync result", (await result.count()) === 0);
  await forceSync.click();
  await waitForResult("同步完成");
  await page.evaluate(() => window.frontendPreview.workspace.setContext(null));
  check("unavailable chat disables force sync", await forceSync.isDisabled());
  await switchChat("b");
  await page.setViewportSize({ width: 1440, height: 1000 });
  check("desktop settings uses the same sync action", await forceSync.isEnabled());
  await forceSync.click();
  await waitForResult("同步完成");
  await page.screenshot({ path: `${screenshots}/snapshot-sync-desktop.png`, fullPage: true });
  await page.evaluate(() =>
    window.frontendPreview.failNextForceSyncBeforeStart("当前快照完整性检查失败", 400),
  );
  await forceSync.click();
  check("preflight prevents repeated sync", await forceSync.isDisabled());
  await waitForResult("当前快照完整性检查失败");
  check(
    "preflight failure does not retain an earlier success",
    !(await control.textContent()).includes("同步完成"),
  );
  await page.evaluate(() =>
    window.frontendPreview.failNextForceSyncBeforeStart("旧聊天的检查错误", 700),
  );
  await forceSync.click();
  await switchChat("a");
  await switchChat("b");
  await page.waitForTimeout(800);
  check(
    "late preflight errors cannot appear in a new settings instance",
    (await result.count()) === 0,
  );
  await page.setViewportSize({ width: 320, height: 720 });
  check(
    "settings sync fits 320px without overflow",
    await control.evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  check("no browser runtime errors", errors.length === 0);
} finally {
  await browser.close();
}
