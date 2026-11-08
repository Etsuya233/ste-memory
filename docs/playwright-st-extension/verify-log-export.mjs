import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  for (const width of [320, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
    const button = (name) => page.getByRole("button", { name, exact: true });
    const label = (name) => page.getByLabel(name, { exact: true });
    await page.locator('[data-action="nav-settings"]').click();
    await button("运行日志").click();
    const rows = page.locator('[data-action="open-log"]');
    await rows.first().waitFor();

    async function exportedText() {
      const pending = page.waitForEvent("download");
      await button("导出日志").click();
      const download = await pending;
      assert.match(download.suggestedFilename(), /^ste-memory-logs-.+\.txt$/);
      assert.equal(await download.failure(), null);
      return readFile(await download.path(), "utf8");
    }
    const all = await exportedText();
    assert.equal(await rows.count(), 30);
    assert.equal(all.match(/\n任务 Key：/g).length, 38);
    assert.match(all, /填表批次完成\n第 1 条预览日志/);
    assert.match(all, /^\[.+\] (信息|警告|错误) · /);
    await button("下一页").click();
    assert.equal(await exportedText(), all, "export includes all pages on either page");

    await label("级别").selectOption("error");
    await label("类型").selectOption("query");
    await label("内容关键词").fill("失败");
    await page.locator('[data-action="filter-task-key"]').click();
    await label("任务 Key").fill("preview-task-2");
    await button("查询").click();
    await page.getByText("任务 Key：preview-task-2", { exact: true }).waitFor();
    await rows.first().waitFor();
    const filtered = await exportedText();
    assert.equal(filtered.match(/\n任务 Key：/g).length, await rows.count());
    assert.ok(filtered.length < all.length);
    assert.ok(
      filtered
        .split("\n\n")
        .every((text) => text.includes("错误 · query\n任务 Key：preview-task-2\n")),
    );
    for (const body of await rows.locator('[data-slot="item-description"]').allTextContents()) {
      assert.ok(filtered.includes(body), "export retains complete multiline bodies");
    }

    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = () => {
        URL.createObjectURL = original;
        throw new Error("export failed for verification");
      };
    });
    await button("导出日志").click();
    await page.getByRole("alert").filter({ hasText: "导出失败" }).waitFor();
    assert.equal(await exportedText(), filtered, "failed export can be retried");
    assert.equal(await page.getByText(/导出失败：/).count(), 0);

    await label("内容关键词").fill("no-matching-log-unique-marker");
    assert.equal(await button("导出日志").isDisabled(), true);
    await button("清除筛选").first().click();
    await rows.first().waitFor();
    assert.equal(await exportedText(), all);
    assert.ok(
      await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: full export, pagination, combined filters, UTF-8 bodies, failure retry, empty state, layout`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
