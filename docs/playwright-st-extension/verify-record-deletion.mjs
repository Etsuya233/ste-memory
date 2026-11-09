import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const snapshot = () => page.evaluate(() => window.frontendPreview.snapshot());
const confirm = () => page.getByRole("button", { name: "确认删除", exact: true }).click();
try {
  for (const width of [320, 390, 1100]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
    await action("open-record").click();
    const before = await snapshot();
    await action("delete-record").click();
    await page.getByRole("alertdialog").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "取消", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.ok(
      await page
        .getByRole("alertdialog")
        .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await snapshot(), before);
    await page.evaluate(() => window.frontendPreview.failNextSave());
    await action("delete-record").click();
    await confirm();
    await page.getByText("模拟删除失败，请重试", { exact: true }).waitFor();
    assert.deepEqual(await snapshot(), before);
    await confirm();
    await page.getByText("记录已删除", { exact: true }).waitFor();
    assert.equal((await snapshot()).length, before.length - 1);
    assert.equal(await action("delete-record").count(), 0);
  }
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await page.locator("[data-record-field]:visible").first().click();
  const before = await snapshot();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("未保存的修改");
  await action("delete-record").click();
  await page.getByText("当前未保存的修改也会丢弃。", { exact: false }).waitFor();
  await page.evaluate(() => window.frontendPreview.failNextPersistence());
  await confirm();
  await page.getByText("记录已删除", { exact: true }).waitFor();
  await page.getByText("记忆已提交、尚未核验：preview file failure", { exact: false }).waitFor();
  assert.equal((await snapshot()).length, before.length - 1);
  assert.equal(await action("save-record").count(), 0);
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("open-record").click();
  await action("delete-record").click();
  await page.evaluate(() => window.frontendPreview.switchChat("b"));
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  await page.evaluate(() => window.frontendPreview.switchChat("a"));
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS record deletion: 320/390/1100px, cancel focus, failure retry, table editor draft, committed persistence failure",
  );
} finally {
  await browser.close();
}
