import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
const entries = () => page.locator('[data-action="open-log"]');
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-settings").click();
  await button("运行日志").click();
  await action("open-log").waitFor();
  check("logs first page limits visible rows", (await entries().count()) === 30);
  await button("下一页").click();
  check(
    "logs pagination shows remaining rows",
    (await entries().count()) > 0 && (await entries().count()) < 30,
  );
  const original = await entries().first().getAttribute("data-log-key");
  await action("open-log").click();
  await page.getByTestId("log-text").waitFor();
  check(
    "log detail displays opaque text",
    (await page.getByTestId("log-text").textContent()).length > 0,
  );
  await action("page-back").click();
  check(
    "detail return retains pagination",
    (await button("上一页").isEnabled()) &&
      (await entries().first().getAttribute("data-log-key")) === original,
  );
  await button("上一页").click();
  const level = await entries().first().getAttribute("data-log-level");
  const type = await entries().first().getAttribute("data-log-type");
  const key = await entries().first().getAttribute("data-log-key");
  await label("级别").selectOption(level);
  await label("类型").selectOption(type);
  check(
    "level and type filters compose",
    (await entries().count()) > 0 &&
      (await entries().evaluateAll(
        (elements, { level, type }) =>
          elements.every((el) => el.dataset.logLevel === level && el.dataset.logType === type),
        { level, type },
      )),
  );
  await label("内容关键词").fill("no-matching-log-unique-marker");
  await page.getByText("没有符合条件的日志", { exact: true }).waitFor();
  check("keyword filter has honest empty state", (await entries().count()) === 0);
  await label("内容关键词").fill("");
  await label("级别").selectOption("");
  await label("类型").selectOption("");
  await action("filter-task-key").click();
  await label("任务 Key").fill(key);
  await button("查询").click();
  await page.getByText(`任务 Key：${key}`, { exact: true }).waitFor();
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll('[data-action="open-log"]')].every(
        (el) => el.dataset.logKey === key,
      ),
    key,
  );
  check(
    "task key query uses exact key",
    await entries().evaluateAll(
      (elements, key) => elements.every((el) => el.dataset.logKey === key),
      key,
    ),
  );
  await button("刷新日志").click();
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll('[data-action="open-log"]')].every(
        (el) => el.dataset.logKey === key,
      ),
    key,
  );
  await action("filter-task-key").click();
  check("manual refresh retains key filter", (await label("任务 Key").inputValue()) === key);
  await button("清除").click();
  await page.getByText(`任务 Key：${key}`, { exact: true }).waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="open-log"]').length === 30,
  );
  const before = await entries().count();
  await button("清空全部日志").click();
  await button("取消").click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  check("cancel log clear leaves data", (await entries().count()) === before);
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/settings-logs-320.png` });
  await button("清空全部日志").click();
  await button("确认清空日志").click();
  await page.getByText("还没有日志", { exact: true }).waitFor();
  check("confirmed clear removes all logs", (await entries().count()) === 0);
  check("log clear applies beyond prior task filter", (await entries().count()) === 0);
  check(
    "320px logs page has no horizontal overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  check("no logs browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
