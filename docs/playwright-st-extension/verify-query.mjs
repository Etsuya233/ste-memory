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
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  permissions: ["clipboard-read", "clipboard-write"],
});
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const history = (key) =>
  page.evaluate((key) => window.frontendPreview.queryStore.getHistory(key), key);
const waitDone = (key) =>
  page.waitForFunction(
    (key) =>
      window.frontendPreview.queryStore.getHistory(key).length > 0 &&
      !window.frontendPreview.queryStore.getRun(key),
    key,
  );
const waitRunning = (key) =>
  page.waitForFunction((key) => !!window.frontendPreview.queryStore.getRun(key), key);
async function openQuery() {
  await action("nav-settings").click();
  await button("记忆问答").click();
}
async function send(text) {
  await action("query-chat-input").fill(text);
  await action("query-chat-send").click();
}
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
try {
  await page.goto(url);
  await openQuery();
  await send("书店里有谁？");
  await waitDone("space-a:query");
  const first = await history("space-a:query");
  check(
    "query stores user and assistant in current space",
    first.length === 2 && first[0].text === "书店里有谁？" && first[1].status === "done",
  );
  const kinds = await page
    .locator('[data-query-message="assistant"]')
    .first()
    .locator("[data-query-segment]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-query-segment")));
  check(
    "thinking tool and text retain event order",
    JSON.stringify(kinds) === JSON.stringify(first[1].segments.map((segment) => segment.kind)) &&
      kinds.includes("tool") &&
      kinds.includes("thinking"),
  );
  const tool = page.locator('[data-query-segment="tool"]').first();
  await tool.getByRole("button").click();
  check(
    "tool arguments and result can be inspected",
    (await tool.getByRole("heading", { name: "参数", exact: true }).isVisible()) &&
      (await tool.getByRole("heading", { name: "结果", exact: true }).isVisible()),
  );
  await action("copy-answer").click();
  check("answer copies through clipboard", await button("已复制回答").isVisible());
  await send("再告诉我更多。");
  await waitDone("space-a:query");
  check("multiple rounds append to current history", (await history("space-a:query")).length === 4);
  const secondInput = await page.evaluate(() => window.frontendPreview.queryInputs()[1]);
  check(
    "multiple rounds send only user and assistant text",
    secondInput.length === 3 &&
      secondInput.every((message) => Object.keys(message).sort().join(",") === "role,text") &&
      secondInput[1].role === "assistant" &&
      !secondInput[1].text.includes("检查记忆"),
  );
  await page.getByRole("tab", { name: "填写", exact: true }).click();
  check(
    "fill mode has independent history",
    await page.getByText("想新增或修改什么？", { exact: true }).isVisible(),
  );
  await send("新增书店记忆，确认提交。");
  await waitDone("space-a:fill");
  check(
    "fill response shows committed receipt",
    (await history("space-a:fill")).at(-1).commit?.status === "committed" &&
      (await page.locator("[role=alert]").allTextContents()).join(" ").includes("已提交"),
  );
  await action("query-refresh").click();
  await page.getByText("记录已刷新。", { exact: true }).waitFor();
  check("committed records can be refreshed", true);
  await page.getByRole("tab", { name: "查询", exact: true }).click();
  check(
    "switching mode restores query history",
    (await page.locator('[data-query-message="user"]').count()) === 2,
  );
  await page.evaluate(() => window.frontendPreview.delayQuery(1000));
  await send("在后台查询");
  await waitRunning("space-a:query");
  await action("nav-tables").click();
  check(
    "leaving page keeps original run active",
    await page.evaluate(() => !!window.frontendPreview.queryStore.getRun("space-a:query")),
  );
  await waitDone("space-a:query");
  await openQuery();
  check(
    "returning displays completed background history",
    (await page.locator('[data-query-message="user"]').allTextContents())
      .join(" ")
      .includes("在后台查询"),
  );
  await page.evaluate(() => window.frontendPreview.delayQuery(5000));
  await send("停止这一轮");
  await waitRunning("space-a:query");
  await action("query-chat-stop").click();
  await waitDone("space-a:query");
  check(
    "stop aborts only current run",
    !(await page.evaluate(() => !!window.frontendPreview.queryStore.getRun("space-a:query"))),
  );
  await page.evaluate(() => {
    window.frontendPreview.delayQuery(0);
    window.frontendPreview.failNextQuery();
  });
  await send("测试失败反馈");
  await waitDone("space-a:query");
  check(
    "failed generation remains visible in history",
    (await history("space-a:query")).at(-1).status === "error",
  );
  await page.evaluate(() => window.frontendPreview.delayQuery(1000));
  await send("对话A的后台问题");
  await waitRunning("space-a:query");
  await switchChat("b");
  check(
    "different space starts with separate history",
    (await page.locator('[data-query-message="user"]').count()) === 0,
  );
  await page.evaluate(() => window.frontendPreview.delayQuery(0));
  await send("对话B的问题");
  await waitDone("space-b:query");
  await waitDone("space-a:query");
  check(
    "background response does not leak into another chat",
    !(await page.locator('[data-query-message="user"]').allTextContents())
      .join(" ")
      .includes("对话A的后台问题"),
  );
  await switchChat("a");
  check(
    "returning restores original space results",
    (await page.locator('[data-query-message="user"]').allTextContents())
      .join(" ")
      .includes("对话A的后台问题"),
  );
  await page.getByRole("tab", { name: "填写", exact: true }).click();
  await page.evaluate(() => window.frontendPreview.delayQuery(1000));
  await send("切换对话时的填写");
  await waitRunning("space-a:fill");
  await switchChat("b");
  await waitDone("space-a:fill");
  check(
    "fill run retains space-switch abandonment receipt",
    (await history("space-a:fill")).at(-1).commit?.status === "abandoned",
  );
  await switchChat("a");
  await page.getByText("对话已切换，变更未提交", { exact: true }).waitFor();
  await action("query-chat-input").fill("未发送的填写草稿");
  await page.getByRole("tab", { name: "查询", exact: true }).click();
  await action("query-chat-input").fill("未发送的问题");
  await page.getByRole("tab", { name: "填写", exact: true }).click();
  check(
    "unsent drafts are independent by mode",
    (await action("query-chat-input").inputValue()) === "未发送的填写草稿",
  );
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "unsent draft protects navigation",
    (await action("query-chat-input").inputValue()) === "未发送的填写草稿",
  );
  await action("page-back").click();
  await button("放弃修改并继续").click();
  await button("记忆问答").click();
  check(
    "confirmed draft discard leaves history intact",
    (await action("query-chat-input").inputValue()) === "" &&
      (await history("space-a:fill")).length >= 4,
  );
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${screenshots}/workbench-query-320.png` });
  check(
    "320px query page has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
