import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const snapshot = () => page.evaluate(() => window.frontendPreview.tasksWorkspace.getSnapshot());
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await page.locator('[data-action="nav-tasks"]:visible').click();
  await button("标记楼层进度").click();
  assert.equal(await button("标记进度").isDisabled(), true);
  await button("取消任务").first().click();
  await page.waitForFunction(
    () =>
      !window.frontendPreview.tasksWorkspace
        .getSnapshot()
        .pending.some((task) => task.status === "running"),
  );
  const before = await page.evaluate(() => window.frontendPreview.tasksSnapshot());
  const from = page.getByLabel("标记起始楼层", { exact: true });
  const to = page.getByLabel("标记结束楼层", { exact: true });
  await from.fill("4");
  await to.fill("6");
  await from.focus();
  const duringRefresh = await page.evaluate(async () => {
    const workspace = window.frontendPreview.tasksWorkspace;
    const tasks = workspace.services.tasks;
    const readLedger = tasks.ledgerStatuses;
    const input = document.getElementById("floor-progress-from");
    tasks.ledgerStatuses = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return readLedger(...args);
    };
    try {
      const refreshing = workspace.refresh();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result = {
        disabled: input.disabled,
        focused: document.activeElement === input,
        sameInput: document.getElementById("floor-progress-from") === input,
        value: input.value,
      };
      await refreshing;
      return result;
    } finally {
      tasks.ledgerStatuses = readLedger;
    }
  });
  assert.deepEqual(duringRefresh, { disabled: false, focused: true, sameInput: true, value: "4" });
  console.log("PASS background refresh keeps floor input enabled, focused and unchanged");
  for (const status of ["processed", "untracked", "error"]) {
    await page.getByLabel("目标状态", { exact: true }).selectOption(status);
    await button("标记进度").click();
    await page.waitForFunction((status) => {
      const ledger = window.frontendPreview.tasksWorkspace.getSnapshot().ledger;
      return [4, 5, 6].every(
        (floor) => ledger.find((item) => item.floor === floor)?.status === status,
      );
    }, status);
    console.log(`PASS range marking and refreshed ledger: ${status}`);
  }
  assert.deepEqual(await page.evaluate(() => window.frontendPreview.tasksSnapshot()), before);
  assert.ok(
    (await page.getByRole("img", { name: /^楼层覆盖/ }).getAttribute("aria-label")).includes(
      "出错 3",
    ),
  );
  await from.fill("7");
  await to.fill("2");
  await button("标记进度").click();
  await page.getByText(/起始楼层不能大于结束楼层/).waitFor();
  assert.equal((await snapshot()).ledger.filter((item) => item.status === "error").length, 3);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await button("标记进度").scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const form = page.locator("form").filter({ has: from });
    assert.equal(
      await form.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    console.log(`PASS floor progress layout: ${width}px`);
  }
  await mkdir("../../node_modules/.cache/frontend-preview/screenshots", { recursive: true });
  await page.screenshot({
    path: "../../node_modules/.cache/frontend-preview/screenshots/floor-progress.png",
  });
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption("b");
  await page.waitForFunction(
    () => window.frontendPreview.tasksWorkspace.getSnapshot().context?.spaceId === "space-b",
  );
  await button("标记楼层进度").click();
  assert.equal(await from.inputValue(), "");
  assert.equal(await to.inputValue(), "");
  assert.equal(
    (await snapshot()).ledger.some((item) => item.status === "error"),
    false,
  );
  console.log("PASS context switch resets form and isolates floor status; task history unchanged");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
