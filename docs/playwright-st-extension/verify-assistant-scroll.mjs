import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const viewport = () => action("assistant-transcript");
let checks = 0;
function check(name, valid) {
  assert.ok(valid, name);
  checks++;
  console.log(`PASS ${name}`);
}
// Include the full Trace height transition and the scroller's ResizeObserver frames.
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const tick = () => (++frames === 24 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );
async function newSession() {
  await action("assistant-menu").click();
  await action("assistant-new").click();
  return page.evaluate(() => window.frontendPreview.queryStore.getSessions()[0].id);
}
async function selectSession(title) {
  await action("assistant-menu").click();
  await page.locator('[data-action="assistant-session-option"]', { hasText: title }).click();
  await settle();
}
const emit = (event) => page.evaluate((event) => window.emitScrollEvent(event), event);
const text = (value) =>
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: value } });
const thinking = (value) =>
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: value } });
const rowPosition = (id) =>
  page.evaluate((id) => {
    const viewport = document.querySelector('[data-action="assistant-transcript"]');
    const row = Array.from(viewport.querySelectorAll("[data-message-id]")).find(
      (node) => node.dataset.messageId === id,
    );
    return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  }, id);
const bottomGap = () =>
  viewport().evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);

try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825/");
  await action("nav-query").click();
  // This first-use empty state has its own new-conversation action.
  await action("assistant-new").click();
  const id = await page.evaluate(() => window.frontendPreview.queryStore.getSessions()[0].id);
  await page.evaluate(async (id) => {
    const store = window.frontendPreview.queryStore;
    store.rename(id, "滚动验收 A");
    await store.withExclusiveSession(id, async () => {
      for (let i = 0; i < 12; i++) {
        const run = store.startRun(id, `历史问题 ${i}`);
        store.recordAgentEvent(id, run.pendingId, {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: Array.from(
              { length: 12 },
              (_, line) => `历史回答 ${i} 的第 ${line} 行，保留稳定阅读位置。`,
            ).join("\n\n"),
          },
        });
        store.finishRun(id, run.pendingId, {
          type: "done",
          stopReason: "stop",
          errorMessage: null,
        });
      }
    });
    window.scrollRun = store.withExclusiveSession(id, async () => {
      const run = store.startRun(id, "连续思考与工具的滚动验收");
      window.emitScrollEvent = (event) => store.recordAgentEvent(id, run.pendingId, event);
      await new Promise((resolve) => {
        window.finishScrollRun = () => {
          store.finishRun(id, run.pendingId, {
            type: "done",
            stopReason: "stop",
            errorMessage: null,
          });
          resolve();
        };
      });
    });
  }, id);
  await page.waitForFunction(() => !!window.emitScrollEvent);
  await settle();
  const anchorId = await page.evaluate(
    (id) => window.frontendPreview.queryStore.get(id).messages.at(-2).id,
    id,
  );
  const anchorTop = await rowPosition(anchorId);
  check(
    "new question anchors near the top with previous context",
    anchorTop >= 0 && anchorTop < 100,
  );
  await thinking("长思考内容。".repeat(1500));
  await settle();
  check(
    "thinking grows without moving the anchored question",
    Math.abs((await rowPosition(anchorId)) - anchorTop) <= 2,
  );
  const lastAssistant = page.locator('[data-query-message="assistant"]').last();
  const thinkingTrigger = lastAssistant.locator(
    '[data-query-segment="thinking"] [data-slot="trace-collapsible-trigger"]',
  );
  check(
    "streamed thinking details stay compact",
    (await thinkingTrigger.getAttribute("aria-expanded")) === "false",
  );
  await emit({
    type: "tool_execution_start",
    toolCallId: "scroll-tool",
    toolName: "query_sql",
    args: { sql: "SELECT name FROM people" },
  });
  await settle();
  check(
    "thinking-to-tool transition preserves turn position",
    Math.abs((await rowPosition(anchorId)) - anchorTop) <= 2,
  );
  await emit({
    type: "tool_execution_end",
    toolCallId: "scroll-tool",
    toolName: "query_sql",
    isError: false,
    result: { details: { rows: [{ name: "爱丽丝" }], truncated: false, limit: 100 } },
  });
  await thinking("第二段思考。".repeat(1200));
  await settle();
  check(
    "tool completion and next thinking preserve turn position",
    Math.abs((await rowPosition(anchorId)) - anchorTop) <= 2,
  );
  for (let chunk = 0; chunk < 10; chunk++) {
    await text(`\n\n回答片段 ${chunk}：${"逐步展示回答，跟随最新内容。".repeat(10)}`);
    await settle();
  }
  check("overflowing streamed answer engages live-edge following", (await bottomGap()) <= 2);
  await viewport().hover();
  await page.mouse.wheel(0, -650);
  await settle();
  const readingTop = await viewport().evaluate((node) => node.scrollTop);
  check("user scrolling up exposes jump-to-latest", await action("assistant-latest").isVisible());
  await text("\n\n用户正在阅读旧内容时追加。".repeat(50));
  await settle();
  check(
    "streaming does not pull a reader back down",
    Math.abs((await viewport().evaluate((node) => node.scrollTop)) - readingTop) <= 2,
  );

  // Save a real row and its screen offset before unmounting the transcript.
  const reading = await viewport().evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const row = Array.from(node.querySelectorAll("[data-message-id]")).find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top };
  });
  const other = await newSession();
  await page.evaluate((id) => window.frontendPreview.queryStore.rename(id, "滚动验收 B"), other);
  await text("\n\n后台继续输出。".repeat(50));
  await selectSession("滚动验收 A");
  check(
    "switching conversations restores the same reading row and offset",
    Math.abs((await rowPosition(reading.id)) - reading.offset) <= 2,
  );
  check(
    "conversation restore preserves paused following",
    await action("assistant-latest").isVisible(),
  );
  const restoredTop = await viewport().evaluate((node) => node.scrollTop);
  await text("\n\n恢复后继续输出。".repeat(30));
  await settle();
  check(
    "restored conversation stays put during streaming",
    Math.abs((await viewport().evaluate((node) => node.scrollTop)) - restoredTop) <= 2,
  );
  await action("nav-records").click();
  await action("nav-query").click();
  await selectSession("滚动验收 A");
  check(
    "leaving and reopening the assistant restores reading position",
    Math.abs((await rowPosition(reading.id)) - reading.offset) <= 2,
  );
  await action("assistant-latest").click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-action="assistant-transcript"]');
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
  });
  check("jump-to-latest reaches the end", (await bottomGap()) <= 2);
  await text("\n\n主动回到最新后恢复跟随。".repeat(30));
  await settle();
  check("jump-to-latest resumes streamed following", (await bottomGap()) <= 2);
  await page.evaluate(async () => {
    window.finishScrollRun();
    await window.scrollRun;
  });
  await settle();
  check("final process collapse keeps the live edge attached", (await bottomGap()) <= 2);
  await action("query-chat-input").fill("输入第一行\n输入第二行\n输入第三行\n输入第四行");
  await settle();
  check("growing the composer keeps the latest reply visible", (await bottomGap()) <= 2);
  await action("query-chat-input").fill("");
  await settle();
  check("shrinking the composer preserves live-edge following", (await bottomGap()) <= 2);
  await page.getByRole("button", { name: "收起工作台", exact: true }).click();
  await page.getByRole("button", { name: "打开预览", exact: true }).focus();
  await page.keyboard.press("Enter");
  await settle();
  check("closing and reopening the workbench retains the latest reply", (await bottomGap()) <= 2);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await settle();
    check(`viewport resize preserves latest position at ${width}px`, (await bottomGap()) <= 2);
    check(
      `transcript fits ${width}px`,
      await viewport().evaluate((node) => node.scrollWidth <= node.clientWidth),
    );
  }
  check("no browser exceptions", errors.length === 0);
  console.log(`${checks} assistant scrolling checks passed`);
} finally {
  await browser.close();
}
