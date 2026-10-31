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
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const snapshot = () => page.evaluate(() => window.frontendPreview.tasksSnapshot());
async function switchChat(key) {
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.tasksWorkspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour") &&
      !window.frontendPreview.tasksWorkspace.getSnapshot().loading,
    key,
  );
}
try {
  await page.goto(url);
  await action("nav-tasks").click();
  await page.getByText("预览模拟：连接临时失败", { exact: true }).waitFor();
  check(
    "task page reads current chat queue",
    await page
      .getByTestId("chat-title")
      .textContent()
      .then((text) => text.includes("雨后")),
  );
  const failed = page.locator('[data-fill-task="space-a-failed-fill"]');
  await failed.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .fillTasks.find((task) => task.runId === "space-a-failed-fill").status === "queued",
  );
  check("failed fill retries in current space", true);
  await failed.getByRole("button", { name: "取消任务", exact: true }).click();
  await button("确认取消任务").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .fillTasks.find((task) => task.runId === "space-a-failed-fill").status === "interrupted",
  );
  check("fill cancellation records terminal state", true);
  const beforeInvalid = (await snapshot()).fillTasks.length;
  await page.getByLabel("起始楼层", { exact: true }).fill("0");
  await page.getByLabel("结束楼层", { exact: true }).fill("99");
  await button("开始填表").click();
  await page
    .getByText(/结束楼层超出范围/)
    .first()
    .waitFor();
  check(
    "invalid floor range creates no task",
    (await snapshot()).fillTasks.length === beforeInvalid,
  );
  check(
    "invalid floor range does not open confirmation",
    (await page.getByRole("alertdialog").count()) === 0,
  );
  await page.getByLabel("结束楼层", { exact: true }).fill("3");
  await button("开始填表").click();
  await page.getByRole("heading", { name: "开始填表任务？", exact: true }).waitFor();
  check(
    "confirmation shows floor range and batch plan",
    (await page.getByText("0–3（4 层）", { exact: true }).count()) === 1 &&
      (await page.getByText("每批 20 层，共 1 批", { exact: true }).count()) === 1,
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "开始填表", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.frontendPreview
      .tasksSnapshot()
      .fillTasks.some(
        (task) => task.memorySpaceId === "space-a" && task.from === 0 && task.to === 3,
      ),
  );
  check("floor submission uses requested range", true);
  check(
    "running task exposes progress semantics",
    (await page.getByRole("progressbar", { name: "当前填表任务进度" }).count()) === 1 &&
      (await page
        .getByRole("progressbar", { name: "当前填表任务进度" })
        .getAttribute("aria-valuenow")) === "1",
  );
  await page.getByLabel("清洗规则", { exact: true }).selectOption("preview-cleaning");
  await page.getByLabel("Agent 预设", { exact: true }).selectOption("preview-chat-preset");
  await page.waitForFunction(() =>
    window.frontendPreview
      .agentPresetSnapshot()
      .some(([key, value]) => key.includes("bookshop") && value === "preview-chat-preset"),
  );
  check("chat cleaning and preset overrides save immediately", true);
  async function openInit() {
    const input = page.getByLabel("初始化文本", { exact: true });
    if (!(await input.isVisible())) await page.getByText("初始化填表", { exact: true }).click();
    await input.waitFor();
    return input;
  }
  let init = await openInit();
  await init.fill("对话A初始化草稿");
  await action("nav-settings").click();
  await button("保留编辑").click();
  check("dirty task navigation retains draft", (await init.inputValue()) === "对话A初始化草稿");
  await switchChat("b");
  init = await openInit();
  check("new chat has independent init draft", (await init.inputValue()) === "");
  check(
    "new chat uses no cleaning or preset override",
    (await page.getByLabel("清洗规则", { exact: true }).inputValue()) === "" &&
      (await page.getByLabel("Agent 预设", { exact: true }).inputValue()) === "",
  );
  await switchChat("a");
  init = await openInit();
  check("returning restores init draft", (await init.inputValue()) === "对话A初始化草稿");
  check(
    "returning restores chat config",
    (await page.getByLabel("清洗规则", { exact: true }).inputValue()) === "preview-cleaning" &&
      (await page.getByLabel("Agent 预设", { exact: true }).inputValue()) === "preview-chat-preset",
  );
  await button("提交初始化任务").click();
  await page.waitForFunction(() =>
    window.frontendPreview
      .tasksSnapshot()
      .fillTasks.some(
        (task) =>
          task.kind === "init" &&
          task.initText === "对话A初始化草稿" &&
          task.memorySpaceId === "space-a",
      ),
  );
  check("init submission clears submitted draft", (await init.inputValue()) === "");
  await page.getByText("向量任务", { exact: true }).click();
  await page.getByRole("checkbox", { name: "选择 旅人 01 全部字段", exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "选择 旅人 01 全部字段", exact: true }).click();
  await button("重试选中（1）").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .vectorTasks.find((task) => task.id === "space-a-vector-failed").status === "queued",
  );
  check("vector failed task retry works", true);
  await page.getByRole("combobox", { name: "向量任务状态", exact: true }).selectOption("queued");
  await page.getByRole("combobox", { name: "向量任务来源", exact: true }).selectOption("manual");
  await page.waitForFunction(
    () => window.frontendPreview.tasksWorkspace.getSnapshot().vectors.length === 1,
  );
  check("vector status and source filters combine", true);
  await page.getByRole("checkbox", { name: "选择 爱丽丝 全部字段", exact: true }).click();
  await button("取消选中（1）").click();
  await button("确认取消任务").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .vectorTasks.find((task) => task.id === "space-a-vector-queued").status === "cancelled",
  );
  check("vector batch cancellation works", true);
  await action("nav-settings").click();
  const timeout = page.getByLabel("每批填写 Agent 超时（秒）", { exact: true });
  await timeout.fill("777");
  await action("nav-records").click();
  await button("保留编辑").click();
  check("settings dirty navigation retains timeout", (await timeout.inputValue()) === "777");
  await button("保存超时").click();
  await page.waitForFunction(
    () => window.frontendPreview.settingsSnapshot().fillAgentTimeoutSeconds === 777,
  );
  check(
    "timeout persists and retains unrelated defaults",
    await page.evaluate(
      () => window.frontendPreview.settingsSnapshot().mirror.includeHistory === true,
    ),
  );
  await timeout.fill("10");
  await button("保存超时").click();
  check("timeout bounds block invalid save", await timeout.evaluate((el) => !el.validity.valid));
  await timeout.fill("778");
  await action("nav-records").click();
  await button("放弃修改并继续").click();
  await action("nav-settings").click();
  check("discard timeout returns saved value", (await timeout.inputValue()) === "777");
  await page.getByRole("switch", { name: "同步到对话文件", exact: true }).click();
  await page.waitForFunction(() => !window.frontendPreview.settingsSnapshot().mirror.enabled);
  check("mirror switch persists immediately", true);
  await page.getByRole("switch", { name: "启用记忆插件", exact: true }).click();
  await page.waitForFunction(
    () =>
      !window.frontendPreview.settingsSnapshot().enabled &&
      window.frontendPreview.workspace.getSnapshot().context === null &&
      window.frontendPreview.tablesWorkspace.getSnapshot().context === null &&
      window.frontendPreview.tasksWorkspace.getSnapshot().context === null,
  );
  check("disabling gates all context workspaces", true);
  await action("nav-records").click();
  check("disabled plugin hides records", (await action("open-record").count()) === 0);
  await action("nav-settings").click();
  await page.getByRole("switch", { name: "启用记忆插件", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.frontendPreview.settingsSnapshot().enabled &&
      window.frontendPreview.workspace.getSnapshot().context?.spaceId === "space-a",
  );
  await action("nav-records").click();
  await action("open-record").waitFor();
  check("reenable restores current chat records", true);
  await page.setViewportSize({ width: 320, height: 640 });
  await action("nav-tasks").click();
  await page.screenshot({ path: `${screenshots}/workbench-tasks-320.png` });
  check(
    "320px task page no overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await action("nav-settings").click();
  await page.screenshot({ path: `${screenshots}/workbench-settings-320.png` });
  check(
    "320px settings page no overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await action("nav-tasks").click();
  const taskLog = action("open-task-log");
  const taskKey = await taskLog.getAttribute("data-task-key");
  await taskLog.click();
  check(
    "task log action opens the exact task key",
    (await page.getByText(`任务 Key：${taskKey}`, { exact: true }).count()) > 0,
  );
  await action("page-back").click();
  check(
    "task log returns to tasks",
    (await page.getByRole("tab", { name: "填表任务", exact: true }).isVisible()) &&
      (await page.getByTestId("chat-title").textContent())?.includes("雨后"),
  );
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
