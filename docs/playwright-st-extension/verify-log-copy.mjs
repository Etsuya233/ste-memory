import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const preview = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  for (const insecure of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 720 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: preview });
    // Serve the same preview under a genuinely untrusted HTTP origin.
    await context.route("http://ste-memory.test/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${preview}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    const reader = await context.newPage();
    await reader.goto(preview);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(insecure ? "http://ste-memory.test/" : preview);
    assert.equal(await page.evaluate(() => window.isSecureContext), !insecure);
    if (insecure) {
      assert.equal(await page.evaluate(() => typeof navigator.clipboard), "undefined");
    }
    const button = (name) => page.getByRole("button", { name, exact: true });
    await page.locator('[data-action="nav-settings"]').click();
    await button("运行日志").click();
    const rows = page.locator('[data-action="open-log"]');
    await rows.first().waitFor();
    async function readClipboard() {
      await reader.bringToFront();
      const text = await reader.evaluate(() => navigator.clipboard.readText());
      await page.bringToFront();
      return text.replace(/\r\n/g, "\n");
    }
    async function checkPageCopy() {
      const texts = await rows.locator('[data-slot="item-description"]').allTextContents();
      assert.ok(texts.length > 0);
      await button("复制当前页").click();
      await page.getByText("已复制当前页日志", { exact: true }).waitFor();
      const text = await readClipboard();
      assert.equal(text.match(/\n任务 Key：/g).length, texts.length);
      let position = 0;
      for (const body of texts) {
        const index = text.indexOf(body, position);
        assert.ok(index >= position, "full log bodies retain display order");
        position = index + body.length;
      }
      assert.match(text, /^\[.+\] (信息|警告|错误) · /);
      assert.equal(await page.locator("textarea[readonly]").count(), 0);
      return text;
    }
    const firstPage = await checkPageCopy();
    if (!insecure) {
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => {
          throw new DOMException("Clipboard permission denied", "NotAllowedError");
        };
      });
      assert.equal(await checkPageCopy(), firstPage);
    }
    await button("下一页").click();
    assert.equal(await page.getByText("已复制当前页日志", { exact: true }).count(), 0);
    const secondPage = await checkPageCopy();
    assert.notEqual(firstPage, secondPage);
    await rows.first().click();
    const body = await page.getByTestId("log-text").textContent();
    await button("复制内容").click();
    await button("已复制").waitFor();
    assert.equal(await readClipboard(), body);
    await page.locator('[data-action="page-back"]').click();
    await page.getByLabel("级别", { exact: true }).selectOption("error");
    await checkPageCopy();
    await page.getByLabel("内容关键词", { exact: true }).fill("no-matching-log-unique-marker");
    assert.equal(await button("复制当前页").isDisabled(), true);
    assert.ok(
      await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${insecure ? "plain HTTP" : "secure context"}: actual clipboard, pagination, filters, detail, empty state, 320px layout`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
