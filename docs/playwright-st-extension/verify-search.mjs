import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const state = () => page.evaluate(() => window.frontendPreview.searchService.getState());
const search = async (query) => {
  await action("retrieval-query").fill(query);
  await action("retrieval-search").click();
};
const waitStatus = (status) =>
  page.waitForFunction(
    (status) => window.frontendPreview.searchService.getState().status === status,
    status,
  );

try {
  await page.goto(url);
  await action("nav-search").click();
  await page.getByText("先配置向量连接", { exact: true }).waitFor();
  check("missing connection provides setup action", await button("配置向量连接").isVisible());
  await page.evaluate(() => window.frontendPreview.seedSearch());
  await page.getByText("先配置向量连接", { exact: true }).waitFor({ state: "hidden" });
  await search("雨后书店的人物");
  await waitStatus("done");
  const first = await state();
  check(
    "search uses existing indexed records",
    first.result.hits.length > 0 && first.result.coverage.ready > 0,
  );
  check("one embedding request per search", first.calls === 1 && first.result.calls === 1);
  check(
    "default request searches all usable tables",
    first.result.request.selection === null && first.result.request.topK === 10,
  );
  const hit = page.locator("[data-retrieval-hit]").first();
  await hit.getByRole("button", { name: "字段内容与来源分组", exact: true }).click();
  check(
    "result expands field values and source group",
    await hit.getByText(/索引更新/).isVisible(),
  );
  await action("retrieval-open-record").click();
  await page.getByRole("region", { name: "记录详情", exact: true }).waitFor();
  check(
    "result opens shared record detail and evidence",
    await page.getByRole("region", { name: "记录详情", exact: true }).isVisible(),
  );
  await action("nav-search").click();
  check(
    "returning to search restores last submitted query",
    (await action("retrieval-query").inputValue()) === "雨后书店的人物",
  );
  await page.getByRole("button", { name: /搜索选项/ }).click();
  await action("retrieval-top-k").fill("3");
  await action("retrieval-threshold").fill("0.8");
  await page.getByRole("switch", { name: "自选搜索范围", exact: true }).click();
  const group = page.getByRole("checkbox").first();
  await group.waitFor();
  await group.uncheck();
  await search("空组选区");
  await waitStatus("error");
  check("empty custom selection fails before remote query", (await state()).calls === 0);
  await group.check();
  await search("限定范围搜索");
  await waitStatus("done");
  const custom = await state();
  check(
    "custom group and score selection reaches service",
    custom.result.request.selection.length === 1 &&
      custom.result.request.minimumScore === 0.8 &&
      custom.result.request.topK === 3 &&
      custom.result.hits.length <= 3,
  );
  await page.evaluate(() => window.frontendPreview.failNextSearch());
  await search("失败后重试");
  await waitStatus("error");
  check(
    "remote failure is shown",
    (await page.locator("[role=alert]").allTextContents())
      .join(" ")
      .includes("预览模拟：embedding连接失败"),
  );
  await button("重新搜索").click();
  await waitStatus("done");
  check(
    "failed search retries current request once",
    (await state()).request.query === "失败后重试" && (await state()).calls === 1,
  );
  await page.evaluate(() => window.frontendPreview.delaySearch(5000));
  await search("取消中的搜索");
  await waitStatus("embedding");
  await action("retrieval-cancel").click();
  await waitStatus("cancelled");
  check("cancel prevents delayed result publication", (await state()).result === null);
  await search("隐藏中的搜索");
  await waitStatus("embedding");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitStatus("cancelled");
  check("browser visibility event cancels outstanding query", true);
  await search("关闭中的搜索");
  await waitStatus("embedding");
  await action("close-frontend").click();
  await waitStatus("cancelled");
  check("closing workbench cancels outstanding query", true);
  await button("打开预览").focus();
  await button("打开预览").press("Enter");
  await search("切页中的搜索");
  await waitStatus("embedding");
  await action("nav-tables").click();
  await waitStatus("cancelled");
  check("leaving search cancels outstanding query", true);
  await action("nav-search").click();
  await search("切对话中的搜索");
  await waitStatus("embedding");
  const chats = page.getByRole("combobox", { name: "预览对话", exact: true });
  await chats.selectOption("b");
  await waitStatus("idle");
  check(
    "new chat clears old results and query",
    (await state()).result === null && (await action("retrieval-query").inputValue()) === "",
  );
  await chats.selectOption("a");
  await waitStatus("idle");
  check(
    "A to B to A keeps obsolete query invalidated",
    (await state()).result === null && (await action("retrieval-query").inputValue()) === "",
  );
  await page.evaluate(() => window.frontendPreview.delaySearch(0));
  await search("窄屏检索");
  await waitStatus("done");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${screenshots}/workbench-search-320.png` });
  check(
    "320px search has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await button("管理索引").click();
  check(
    "index action opens table management",
    await page.locator('[data-action="nav-tables"][aria-current="page"]').isVisible(),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
