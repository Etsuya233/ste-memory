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
let checks = 0;
const check = (name, value) => {
  assert.ok(value, name);
  checks++;
  console.log(`PASS ${name}`);
};
const session = (id) => page.evaluate((id) => window.frontendPreview.queryStore.get(id), id);
const waitDone = (id) =>
  page.waitForFunction((id) => {
    const store = window.frontendPreview.queryStore;
    return (
      store.get(id).messages.length && !store.getRun(id) && store.get(id).status !== "committing"
    );
  }, id);
async function openAssistant() {
  await action("nav-settings").click();
  await button("记忆助手").click();
}
async function newSession() {
  const previous = await page.evaluate(() =>
    window.frontendPreview.queryStore.getSessions().map((session) => session.id),
  );
  await action("assistant-new").click();
  return page.evaluate(
    (previous) =>
      window.frontendPreview.queryStore
        .getSessions()
        .find((session) => !previous.includes(session.id)).id,
    previous,
  );
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
async function selectSession(title) {
  await action("assistant-sessions").click();
  await page
    .getByRole("region", { name: "会话列表" })
    .getByRole("button", { name: title, exact: true })
    .click();
}
try {
  await page.goto(url);
  await openAssistant();
  check(
    "unified assistant without mode tabs",
    (await page.getByRole("heading", { name: "记忆助手", exact: true }).isVisible()) &&
      (await page.getByRole("tab", { name: "查询", exact: true }).count()) === 0,
  );
  const a = await newSession();
  await send("书店里有谁？");
  await waitDone(a);
  const first = await session(a);
  check(
    "query with full tool transcript",
    first.messages.length === 2 &&
      first.transcript.some((message) => message.role === "toolResult") &&
      first.proposal.operations.length === 0,
  );
  const kinds = await page
    .locator('[data-query-message="assistant"]')
    .first()
    .locator("[data-query-segment]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-query-segment")));
  check(
    "thinking tool and text inspectable",
    kinds.includes("tool") && kinds.includes("thinking") && kinds.includes("text"),
  );
  check(
    "messages use aligned bubbles and trace instead of cards",
    (await page
      .locator(
        '[data-query-message="user"][data-slot="message"][data-align="end"] [data-slot="bubble-content"]',
      )
      .count()) === 1 &&
      (await page.locator('[data-query-message="assistant"] [data-slot="trace"]').count()) === 2 &&
      (await page.locator('[data-query-message] [data-slot="card"]').count()) === 0,
  );
  const toolTrace = page.locator('[data-query-segment="tool"]').first();
  const toolTrigger = toolTrace.getByRole("button");
  check(
    "completed tool starts collapsed with real result summary",
    (await toolTrigger.getAttribute("aria-expanded")) === "false" &&
      /命中 \d+ 条记录/.test(await toolTrace.innerText()),
  );
  await toolTrigger.focus();
  await toolTrigger.press("Enter");
  await toolTrace.getByRole("heading", { name: "参数", exact: true }).waitFor();
  check(
    "trace keyboard toggle exposes tool arguments and results",
    (await toolTrace.innerText()).includes("query_records") &&
      (await toolTrace.innerText()).includes("table_0"),
  );
  await toolTrigger.press("Enter");
  check(
    "trace keyboard toggle collapses details",
    (await toolTrigger.getAttribute("aria-expanded")) === "false",
  );
  check(
    "prompt controls share an input group",
    (await action("query-chat-input").locator("xpath=..").getAttribute("data-slot")) ===
      "input-group" &&
      (await action("query-chat-send").locator("xpath=..").getAttribute("data-align")) ===
        "block-end",
  );
  await action("copy-answer").click();
  check("copy answer", await button("已复制回答").isVisible());
  await action("assistant-sessions").click();
  await button("重命名 书店里有谁？").click();
  await page.getByLabel("会话名称", { exact: true }).fill("人物整理");
  await button("保存").click();
  await page
    .getByRole("region", { name: "会话列表" })
    .getByRole("button", { name: "人物整理", exact: true })
    .click();
  await action("query-chat-input").fill("尚未发送的草稿");
  const b = await newSession();
  check("new conversation empty", (await session(b)).messages.length === 0);
  await selectSession("人物整理");
  check(
    "input draft restored",
    (await action("query-chat-input").inputValue()) === "尚未发送的草稿",
  );
  await send("新增一个人物");
  await waitDone(a);
  const draft = await session(a);
  check(
    "mutation awaits explicit confirmation",
    draft.proposal.operations.length === 1 &&
      draft.preview.valid &&
      (await action("assistant-confirm").isEnabled()),
  );
  const proposal = page.getByRole("region", { name: "待提交修改", exact: true });
  check(
    "proposal lists actual field before and after values",
    (await proposal.locator("dl dt").count()) > 0 &&
      (await proposal.innerText()).includes("修改前：") &&
      (await proposal.innerText()).includes("修改后：") &&
      (await proposal.innerText()).includes("预览新增人物"),
  );
  await page.addStyleTag({ content: "*, *::before, *::after { text-shadow: 0 0 6px red; }" });
  check(
    "new assistant controls resist host text shadows",
    await page
      .locator(
        '[data-slot="input-group"], [data-slot="trace-collapsible-trigger"], [data-query-message] [data-slot="bubble-content"]',
      )
      .evaluateAll(
        (nodes) =>
          nodes.length > 0 && nodes.every((node) => getComputedStyle(node).textShadow === "none"),
      ),
  );
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await action("assistant-confirm").scrollIntoViewIfNeeded();
    check(
      `proposal and prompt fit ${width}px`,
      await page
        .locator('[aria-label="待提交修改"], [data-slot="input-group"]')
        .evaluateAll(
          (nodes) =>
            nodes.length === 2 && nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
        ),
    );
  }
  await page.screenshot({ path: `${screenshots}/memory-assistant-proposal-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/memory-assistant-proposal-mobile.png` });
  await page.evaluate(() => window.frontendPreview.queryStore.flush());
  await page.reload();
  await openAssistant();
  await selectSession("人物整理");
  check(
    "reload restores proposal and transcript",
    (await session(a)).proposal.operations.length === 1 &&
      (await session(a)).transcript.length === draft.transcript.length,
  );
  await action("assistant-confirm").click();
  await waitDone(a);
  check(
    "confirm commits and clears draft",
    (await session(a)).proposal.operations.length === 0 &&
      (await session(a)).messages.at(-1).commit.status === "committed",
  );
  check(
    "commit summary visible",
    await page.getByText("已提交：创建 1", { exact: false }).isVisible(),
  );
  // Feed the real presentation store a long tool result without invoking another model.
  await page.evaluate((id) => {
    const store = window.frontendPreview.queryStore;
    window.presentationRun = store.withExclusiveSession(id, async () => {
      const run = store.startRun(id, "检查长工具输出");
      store.recordAgentEvent(id, run.pendingId, {
        type: "tool_execution_start",
        toolCallId: "long-tool",
        toolName: "query_sql",
        args: { sql: `SELECT '${"long_sql_".repeat(100)}'` },
      });
      await new Promise((resolve) => {
        window.finishPresentation = () => {
          store.recordAgentEvent(id, run.pendingId, {
            type: "tool_execution_end",
            toolCallId: "long-tool",
            toolName: "query_sql",
            isError: false,
            result: {
              details: { rows: [{ value: "long_json_".repeat(150) }], truncated: true, limit: 1 },
            },
          });
          store.finishRun(id, run.pendingId, {
            type: "done",
            stopReason: "stop",
            errorMessage: null,
          });
          resolve();
        };
      });
    });
  }, a);
  await page.waitForFunction(() => !!window.finishPresentation);
  const streamingTrace = page
    .locator('[data-query-message="assistant"]')
    .last()
    .locator('[data-query-segment="tool"]');
  const streamingTrigger = streamingTrace.getByRole("button");
  check(
    "running trace opens automatically",
    (await streamingTrigger.getAttribute("aria-expanded")) === "true",
  );
  await streamingTrigger.click();
  check(
    "running trace respects manual collapse",
    (await streamingTrigger.getAttribute("aria-expanded")) === "false",
  );
  await page.evaluate(async () => {
    window.finishPresentation();
    await window.presentationRun;
  });
  check(
    "SQL summary exposes truncation",
    (await streamingTrace.innerText()).includes("返回 1 行（已截断）"),
  );
  await streamingTrigger.click();
  await streamingTrace.getByRole("heading", { name: "结果", exact: true }).waitFor();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    check(
      `expanded long SQL and JSON fit ${width}px`,
      await streamingTrace.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    );
  }
  await button("切换亮暗色").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await streamingTrace.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/memory-assistant-trace-dark.png` });
  await button("切换亮暗色").click();
  await page.evaluate(() => window.frontendPreview.delayQuery(60000));
  await send("慢查询");
  await page.waitForFunction((id) => !!window.frontendPreview.queryStore.getRun(id), a);
  const c = await newSession();
  check(
    "switch keeps original running",
    (await session(a)).status === "running" && (await session(c)).status === "idle",
  );
  await page.evaluate(() => window.frontendPreview.queryStore.flush());
  await page.reload();
  await openAssistant();
  check(
    "inflight request marked interrupted",
    (await session(a)).status === "interrupted" &&
      (await session(a)).messages.at(-1).status === "interrupted",
  );
  await selectSession("人物整理");
  await send("继续查询");
  await waitDone(a);
  check("interrupted session resumes", (await session(a)).messages.at(-1).status === "done");
  await page.evaluate(() => window.frontendPreview.delayQuery(60000));
  await send("取消查询");
  await action("query-chat-stop").click();
  await waitDone(a);
  check(
    "stop isolates conversations",
    (await session(a)).messages.at(-1).status === "error" &&
      (await session(b)).messages.length === 0,
  );
  await page.evaluate(() => window.frontendPreview.delayQuery(30));
  await switchChat("b");
  check("different ST chat isolated", (await action("query-chat-input").count()) === 0);
  const other = await newSession();
  await send("另一个对话");
  await waitDone(other);
  await switchChat("a");
  await selectSession("人物整理");
  check(
    "original conversation restored",
    (await session(a)).messages.length > 2 &&
      (await action("assistant-sessions").innerText()).trim() === "人物整理",
  );
  await action("assistant-sessions").click();
  await page.getByRole("button", { name: "删除 新会话", exact: true }).first().click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除会话", exact: true })
    .click();
  check(
    "delete one conversation",
    (await page.evaluate(
      () =>
        window.frontendPreview.queryStore
          .getSessions()
          .filter((session) => session.spaceId === "space-a").length,
    )) === 2,
  );
  await page
    .getByRole("region", { name: "会话列表" })
    .getByRole("button", { name: "人物整理", exact: true })
    .click();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    check(
      `no horizontal overflow at ${width}px`,
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
  }
  await page.screenshot({ path: `${screenshots}/memory-assistant-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/memory-assistant-mobile.png` });
  check("no browser errors", errors.length === 0);
  console.log(`${checks} memory assistant checks passed`);
} finally {
  await browser.close();
}
