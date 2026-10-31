import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const snapshot = () => page.evaluate(() => window.frontendPreview.tasksSnapshot());
const runningStatus = async (space = "space-a") =>
  (await snapshot()).fillTasks.find((task) => task.runId === `${space}-running-fill`).status;
const runningCancel = page.locator(
  '[data-action="cancel-task"][data-task-key="space-a-running-fill"]',
);
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await page.locator('[data-action="nav-tasks"]').click();
  check(
    "cancel uses destructive button variant",
    await runningCancel.evaluate(
      (el) =>
        el.className.includes("ste:text-destructive") &&
        !el.className.includes("ste:border-border"),
    ),
  );
  await runningCancel.click();
  await page.getByRole("alertdialog").waitFor();
  check("first click keeps running task", (await runningStatus()) === "running");
  check(
    "dialog names target floors and retained results",
    (await page.getByRole("alertdialog").innerText()).includes("8–11") &&
      (await page.getByRole("alertdialog").innerText()).includes("已保存的批次会保留"),
  );
  check(
    "default focus keeps task running",
    await button("继续运行").evaluate((el) => document.activeElement === el),
  );
  await button("继续运行").click();
  check("dismiss leaves task unchanged", (await runningStatus()) === "running");
  await runningCancel.click();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  check("escape leaves task unchanged", (await runningStatus()) === "running");

  await page.setViewportSize({ width: 320, height: 640 });
  await runningCancel.click();
  await page.getByRole("alertdialog").waitFor();
  check(
    "confirmation fits 320px viewport",
    await page.getByRole("alertdialog").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.x >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth;
    }),
  );
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/task-cancellation-320.png` });
  await button("确认取消任务").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .fillTasks.find((task) => task.runId === "space-a-running-fill").status === "interrupted",
  );
  check("confirmation cancels selected running task", (await runningStatus()) === "interrupted");

  await page.locator('[data-action="cancel-task"][data-task-key="space-a-failed-fill"]').click();
  await page.evaluate(() => window.frontendPreview.switchChat("b"));
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  check(
    "chat switch dismisses old confirmation",
    (await snapshot()).fillTasks.find((task) => task.runId === "space-a-failed-fill").status ===
      "failed" && (await runningStatus("space-b")) === "running",
  );

  await page.getByRole("tab", { name: "向量任务", exact: true }).click();
  const vector = page.locator('[data-vector-task="space-b-vector-queued"]');
  await vector.getByRole("button", { name: "取消任务", exact: true }).click();
  check(
    "single vector cancellation requires confirmation",
    (await snapshot()).vectorTasks.find((task) => task.id === "space-b-vector-queued").status ===
      "queued",
  );
  await button("继续运行").click();
  await vector.getByRole("checkbox").click();
  await button("取消选中（1）").click();
  check(
    "batch cancellation requires confirmation",
    (await snapshot()).vectorTasks.find((task) => task.id === "space-b-vector-queued").status ===
      "queued",
  );
  await button("确认取消任务").click();
  await page.waitForFunction(
    () =>
      window.frontendPreview
        .tasksSnapshot()
        .vectorTasks.find((task) => task.id === "space-b-vector-queued").status === "cancelled",
  );
  check("batch confirmation cancels captured selection", true);
  check("no browser exceptions", errors.length === 0);
} finally {
  await browser.close();
}
