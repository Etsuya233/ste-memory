import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const notice = page.getByTestId("snapshot-save-notice");
const control = page.getByTestId("snapshot-sync-control");
const state = () => page.evaluate(() => window.frontendPreview.snapshotSaveState());
const metrics = () => page.evaluate(() => window.frontendPreview.snapshotSaveMetrics());
const waitState = (kind) =>
  page.waitForFunction((kind) => window.frontendPreview.snapshotSaveState().kind === kind, kind);
let checks = 0;
function check(label, value) {
  assert.ok(value, label);
  checks++;
  console.log(`PASS ${label}`);
}

try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-settings").click();
  await page.evaluate(() => window.frontendPreview.saveCommittedSnapshot());
  check(
    "ordinary persistence is submitted without claiming verification",
    (await state()).kind === "submitted" &&
      (await metrics()).verify === 0 &&
      (await control.getAttribute("data-save-state")) === "submitted",
  );
  await action("force-sync-memory").click();
  await waitState("verified");
  check("force sync verifies the real adapter snapshot", (await metrics()).verify === 1);

  await page.evaluate(() => {
    window.workflowPending = window.frontendPreview.replaceSnapshot({ confirmDelay: 700 });
  });
  await waitState("confirming");
  check(
    "confirmation is an observable busy phase",
    (await action("force-sync-memory").isDisabled()) &&
      (await control.textContent()).includes("文件已核验，正在完成操作"),
  );
  const confirmingId = (await state()).operationId;
  await page.evaluate(() => window.workflowPending);
  check(
    "confirmation completes the same operation",
    (await state()).kind === "verified" && (await state()).operationId === confirmingId,
  );

  await page.evaluate(() =>
    window.frontendPreview.showSaveFailure("工作流核验失败", "replacement"),
  );
  const failed = await state();
  check(
    "replacement failure carries verify stage and operation identity",
    failed.kind === "failed" && failed.phase === "verify" && failed.operation === "replacement",
  );
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await waitState("verified");
  check(
    "replacement recovery preserves its reviewed operation",
    (await state()).operationId === failed.operationId,
  );

  await page.evaluate(() => window.frontendPreview.replaceSnapshot({ cleanupFailures: 1 }));
  check(
    "cleanup failure preserves verified durability",
    (await state()).kind === "verified" &&
      (await state()).cleanup.kind === "failed" &&
      (await notice.getAttribute("data-cleanup-state")) === "failed",
  );
  await page.evaluate(() => window.frontendPreview.saveCommittedSnapshot());
  const newer = await state();
  check(
    "retirement warning coexists with a newer ordinary commit",
    newer.kind === "submitted" && newer.cleanup.kind === "failed",
  );
  const beforeCleanup = await metrics();
  await notice.getByRole("button", { name: "重试清理", exact: true }).click();
  await notice.waitFor({ state: "detached" });
  const afterCleanup = await metrics();
  const cleaned = await state();
  check(
    "cleanup retry never uploads or verifies again",
    afterCleanup.submit === beforeCleanup.submit &&
      afterCleanup.verify === beforeCleanup.verify &&
      afterCleanup.cleanup === beforeCleanup.cleanup + 1,
  );
  check(
    "cleanup completion cannot overwrite a newer save",
    cleaned.kind === "submitted" &&
      cleaned.operationId === newer.operationId &&
      cleaned.cleanup.kind === "idle",
  );

  await page.evaluate(() => window.frontendPreview.delayNextForceSync(600));
  await action("force-sync-memory").click();
  await waitState("verifying");
  const oldId = (await state()).operationId;
  await page.evaluate(() => window.frontendPreview.saveCommittedSnapshot());
  const latestId = (await state()).operationId;
  await page.waitForTimeout(700);
  check(
    "late verification cannot mark a newer ordinary snapshot verified",
    latestId > oldId &&
      (await state()).kind === "submitted" &&
      (await state()).operationId === latestId,
  );

  await action("nav-records").click();
  const beforeRecords = await page.evaluate(() => window.frontendPreview.snapshot().length);
  await action("create-record").click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("持久化恢复仅创建一次");
  await page.evaluate(() => window.frontendPreview.failNextPersistence());
  await action("save-record").click();
  await action("edit-record").waitFor();
  await notice.waitFor();
  check(
    "a committed record leaves its editor despite file failure",
    (await page.evaluate(() => window.frontendPreview.snapshot().length)) === beforeRecords + 1 &&
      (await state()).kind === "failed" &&
      (await state()).phase === "submit",
  );
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await notice.waitFor({ state: "detached" });
  check(
    "save recovery does not replay record creation",
    (await page.evaluate(
      () =>
        window.frontendPreview
          .snapshot()
          .filter((record) => record.payload.name === "持久化恢复仅创建一次").length,
    )) === 1,
  );

  await action("edit-record").click();
  const recordName = page.getByRole("textbox", { name: "名称", exact: true });
  await recordName.fill("门控期间保留的草稿");
  check("record draft can save before replacement starts", await action("save-record").isEnabled());
  await page.evaluate(() => window.frontendPreview.showSaveFailure("候选等待核验", "replacement"));
  check(
    "live replacement gate disables record save and retains the draft",
    (await action("save-record").isDisabled()) &&
      (await recordName.inputValue()) === "门控期间保留的草稿",
  );
  await action("cancel-edit").click();
  await page.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await notice.waitFor({ state: "detached" });

  await action("nav-tasks").click();
  await page.getByLabel("起始楼层", { exact: true }).fill("0");
  await page.getByLabel("结束楼层", { exact: true }).fill("3");
  await page.getByRole("button", { name: "开始填表", exact: true }).click();
  const submitDialog = page.getByRole("alertdialog");
  await submitDialog.waitFor();
  const beforeTasks = await page.evaluate(
    () => window.frontendPreview.tasksSnapshot().fillTasks.length,
  );
  await page.evaluate(() =>
    window.frontendPreview.showSaveFailure("对话候选待核验", "replacement"),
  );
  check(
    "an already-open task confirmation obeys the live write gate",
    (await submitDialog.getByRole("button", { name: "开始填表", exact: true }).isDisabled()) &&
      beforeTasks ===
        (await page.evaluate(() => window.frontendPreview.tasksSnapshot().fillTasks.length)),
  );
  await submitDialog.getByRole("button", { name: "取消", exact: true }).click();
  check(
    "write gate leaves running-task cancellation available",
    await page
      .locator('[data-action="cancel-task"][data-task-key="space-a-running-fill"]')
      .isEnabled(),
  );
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await notice.waitFor({ state: "detached" });

  await action("nav-query").click();
  if (await action("assistant-menu").count()) {
    await action("assistant-menu").click();
  }
  await action("assistant-new").click();
  const id = await page.evaluate(() => window.frontendPreview.queryStore.getSessions()[0].id);
  await action("query-chat-input").fill("新增一个人物");
  await action("query-chat-send").click();
  await page.waitForFunction(
    (id) =>
      !!window.frontendPreview.queryStore.get(id).previewId &&
      !window.frontendPreview.queryStore.isExecuting(id),
    id,
  );
  const originalToken = await page.evaluate(
    (id) => window.frontendPreview.queryStore.get(id).previewId,
    id,
  );
  check(
    "reviewed proposal is confirmable before a write gate",
    await action("assistant-confirm").isEnabled(),
  );
  await page.evaluate(() =>
    window.frontendPreview.showSaveFailure("助手目标候选待核验", "replacement"),
  );
  check(
    "assistant confirmation obeys the shared gate while querying remains available",
    (await action("assistant-confirm").isDisabled()) &&
      (await action("query-chat-send").count()) === 1 &&
      (await action("query-chat-input").isEnabled()),
  );
  await notice.getByRole("button", { name: "重试保存", exact: true }).click();
  await notice.waitFor({ state: "detached" });
  await page.evaluate(
    async ({ id, token }) => {
      window.frontendPreview.queryStore.beginCommit(id, token);
      await window.frontendPreview.queryStore.flush();
    },
    { id, token: originalToken },
  );
  await page.reload();
  await action("nav-query").click();
  await page.waitForFunction(
    (id) =>
      window.frontendPreview.queryStore
        .getSessions()
        .some((session) => session.id === id && session.commitUncertain),
    id,
  );
  const recoveryActions = await page.evaluate(
    (id) => window.frontendPreview.queryStore.getSessionActions(id),
    id,
  );
  check(
    "interrupted confirmation permits inspection and blocks another write",
    recoveryActions.send.allowed &&
      !recoveryActions.prepare.allowed &&
      recoveryActions.prepare.code === "commit-uncertain" &&
      !recoveryActions.confirm.allowed &&
      recoveryActions.discard.allowed,
  );
  await page
    .getByText("上次提交被中断，结果待核对。请先查询记录，放弃旧提案后再准备新的修改。", {
      exact: true,
    })
    .waitFor();
  const beforeInspection = await page.evaluate(() =>
    JSON.stringify(window.frontendPreview.snapshot()),
  );
  await action("query-chat-input").fill("书店里有谁？");
  await action("query-chat-send").click();
  await page.waitForFunction(
    (id) =>
      window.frontendPreview.queryStore.get(id).status === "idle" &&
      !window.frontendPreview.queryStore.isExecuting(id),
    id,
  );
  check(
    "uncertain commit can query records without changing memory",
    beforeInspection ===
      (await page.evaluate(() => JSON.stringify(window.frontendPreview.snapshot()))) &&
      (await page.evaluate(
        (id) =>
          window.frontendPreview.queryStore
            .get(id)
            .transcript.some(
              (message) => message.role === "toolResult" && message.toolName === "query_records",
            ),
        id,
      )),
  );
  check(
    "uncertain inspection cannot restore an old confirmation token",
    (await action("assistant-confirm").isDisabled()) &&
      (await page.evaluate(
        (id) => window.frontendPreview.queryStore.get(id).previewId === undefined,
        id,
      )),
  );
  check(
    "uncertain recovery fits a 320px surface",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await page.screenshot({ path: `${screenshots}/workflow-lifecycle-320.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  check(
    "uncertain recovery fits a desktop surface",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await page.screenshot({ path: `${screenshots}/workflow-lifecycle-desktop.png`, fullPage: true });
  check("no browser runtime errors", errors.length === 0);
  console.log(`PASS ${checks} workflow lifecycle checks`);
} finally {
  await browser.close();
}
