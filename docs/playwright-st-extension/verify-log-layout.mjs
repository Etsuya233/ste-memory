import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const failures = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
  if (!value) failures.push(name);
};
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
try {
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
    await page.locator('[data-action="nav-settings"]').click();
    await page.getByRole("button", { name: "运行日志", exact: true }).click();
    const rows = page.locator('[data-action="open-log"]');
    await rows.first().waitFor();
    const list = page.locator('[data-page-scroll="logs"]');
    const listDimensions = await list.evaluate((el) => ({
      height: el.clientHeight,
      content: el.scrollHeight,
    }));
    console.log(JSON.stringify({ width, list: listDimensions }));
    check(
      `${width}px list content extends beyond viewport`,
      listDimensions.content > listDimensions.height,
    );
    await list.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    const position = await list.evaluate((el) => el.scrollTop);
    check(`${width}px wheel scrolls the log list`, position > 0);

    const target = rows.nth(12);
    const id = Number(await target.getAttribute("data-log-id"));
    const text = Array.from(
      { length: 120 },
      (_, i) =>
        `第 ${i + 1} 行日志：模型请求与工具结果。${i === 30 ? "long-token-".repeat(60) : ""}`,
    ).join("\n");
    await page.evaluate(({ id, text }) => window.frontendPreview.setLogText(id, text), {
      id,
      text,
    });
    await page.getByRole("button", { name: "刷新日志", exact: true }).click();
    await page.waitForFunction(
      ({ id, text }) =>
        document.querySelector(`[data-log-id="${id}"]`)?.textContent.includes(text.slice(0, 15)),
      { id, text },
    );
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const listPosition = await list.evaluate((el) => el.scrollTop);
    await target.click();
    const detail = page.locator('[data-page-scroll="log-detail"]');
    const body = page.getByTestId("log-text");
    await body.waitFor();
    const dimensions = await body.evaluate((el) => ({
      height: el.clientHeight,
      content: el.scrollHeight,
      parent: el.parentElement.clientHeight,
    }));
    console.log(JSON.stringify({ width, detail: dimensions }));
    check(
      `${width}px long log retains readable height`,
      dimensions.height >= Math.min(240, dimensions.parent * 0.5),
    );
    check(
      `${width}px metadata keeps natural height`,
      await detail.locator("dl").evaluate((el) => el.scrollHeight <= el.clientHeight),
    );
    await body.hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(200);
    check(`${width}px log text scrolls`, await body.evaluate((el) => el.scrollTop > 0));
    await page.screenshot({ path: `${screenshots}/logs-detail-${width}.png` });
    await detail.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    check(
      `${width}px related logs remain reachable`,
      await detail.evaluate((el) => {
        const rows = el.querySelectorAll('[data-action="open-related-log"]');
        const lastRow = rows[rows.length - 1];
        return (
          el.scrollTop > 0 &&
          lastRow.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1
        );
      }),
    );
    check(
      `${width}px no horizontal page overflow`,
      await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await page.locator('[data-action="page-back"]').click();
    check(
      `${width}px returning preserves list scroll`,
      await list.evaluate((el, expected) => Math.abs(el.scrollTop - expected) <= 1, listPosition),
    );
  }
  check("no browser exceptions", errors.length === 0);
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
