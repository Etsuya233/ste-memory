import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const url = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const errors = [];
let checks = 0;
const check = (name, valid) => {
  assert.ok(valid, name);
  checks++;
  console.log(`PASS ${name}`);
};
const action = (tab, name) => tab.locator(`[data-action="${name}"]:visible`).first();
async function open(tab) {
  tab.setDefaultTimeout(15000);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(url);
  await action(tab, "nav-query").click();
}
const done = (tab, id) =>
  tab.waitForFunction((id) => {
    const store = window.frontendPreview.queryStore;
    return store.get(id).status === "idle" && !store.isExecuting(id);
  }, id);
const unloadProtected = (tab) =>
  tab.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
try {
  await open(page);
  await action(page, "assistant-new").click();
  const id = await page.evaluate(() => window.frontendPreview.queryStore.getSessions()[0].id);
  await action(page, "query-chat-input").fill("新增一个人物");
  await action(page, "query-chat-send").click();
  await done(page, id);
  await page.waitForFunction((id) => !!window.frontendPreview.queryStore.get(id).previewId, id);
  const token = await page.evaluate(
    (id) => window.frontendPreview.queryStore.get(id).previewId,
    id,
  );
  const peer = await context.newPage();
  await open(peer);
  await peer.waitForFunction(
    (id) => window.frontendPreview.queryStore.getSessions().some((item) => item.id === id),
    id,
  );
  check(
    "peer loads the same pending proposal",
    await peer.evaluate(
      ({ id, token }) => window.frontendPreview.queryStore.get(id).previewId === token,
      { id, token },
    ),
  );
  const results = await Promise.all(
    [page, peer].map((tab) =>
      tab.evaluate(
        async ({ id, token }) => {
          try {
            return await window.frontendPreview.assistantService.confirm(id, token);
          } catch (error) {
            return { status: "rejected", message: error.message };
          }
        },
        { id, token },
      ),
    ),
  );
  check(
    "cross-tab confirmation commits exactly once",
    results.filter((result) => result.status === "committed").length === 1 &&
      results.filter((result) => result.status === "rejected").length === 1,
  );
  const counts = await Promise.all(
    [page, peer].map((tab) => tab.evaluate(() => window.frontendPreview.snapshot().length)),
  );
  check("only one tab adds a record", counts[0] + counts[1] === 105);
  await done(page, id);
  await done(peer, id);
  await page.evaluate(() => window.frontendPreview.delayQuery(60000));
  await action(page, "query-chat-input").fill("等待中的查询");
  await action(page, "query-chat-send").click();
  await page.waitForFunction((id) => !!window.frontendPreview.queryStore.getRun(id), id);
  await peer.waitForFunction(
    (id) => window.frontendPreview.queryStore.get(id).status === "running",
    id,
  );
  check(
    "peer sees active run instead of recovering it",
    await peer.evaluate(
      (id) =>
        window.frontendPreview.queryStore.get(id).status === "running" &&
        !window.frontendPreview.queryStore.getRun(id),
      id,
    ),
  );
  check(
    "peer cannot edit an active foreign run",
    await action(peer, "query-chat-input").isDisabled(),
  );
  const third = await context.newPage();
  await open(third);
  await third.waitForFunction(
    (id) => window.frontendPreview.queryStore.getSessions().some((item) => item.id === id),
    id,
  );
  check(
    "new tab preserves another tab's active status",
    await third.evaluate(
      (id) => window.frontendPreview.queryStore.get(id).status === "running",
      id,
    ),
  );
  await page.evaluate(() => window.frontendPreview.queryStore.flush());
  await page.close();
  await peer.waitForFunction(
    (id) => window.frontendPreview.queryStore.get(id).status === "interrupted",
    id,
  );
  await third.waitForFunction(
    (id) => window.frontendPreview.queryStore.get(id).status === "interrupted",
    id,
  );
  check(
    "open peers recover a run after its owner closes",
    await action(peer, "query-chat-input").isEnabled(),
  );
  await third.close();
  await action(peer, "query-chat-input").fill("继续查询");
  await action(peer, "query-chat-send").click();
  await done(peer, id);
  check(
    "recovered conversation resumes",
    await peer.evaluate(
      (id) => window.frontendPreview.queryStore.get(id).messages.at(-1).status === "done",
      id,
    ),
  );
  await peer.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.restoreAssistantWrites = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "assistantSessions")
        throw new DOMException("injected quota failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await action(peer, "query-chat-input").fill("不能丢失的未保存草稿");
  await peer.waitForFunction(() => !!window.frontendPreview.queryStore.storageError());
  check("failed session save protects refresh on assistant page", await unloadProtected(peer));
  await action(peer, "nav-records").click();
  check("refresh remains protected after leaving assistant", await unloadProtected(peer));
  await action(peer, "close-frontend").click();
  check("refresh remains protected with panel closed", await unloadProtected(peer));
  await peer.evaluate(async () => {
    window.restoreAssistantWrites();
    await window.frontendPreview.queryStore.retrySave();
  });
  check("refresh protection clears after successful retry", !(await unloadProtected(peer)));
  check("no browser exceptions", errors.length === 0);
  console.log(`${checks} assistant concurrency and persistence checks passed`);
} finally {
  await browser.close();
}
