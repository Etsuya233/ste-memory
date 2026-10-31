import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const toast = page.locator('[data-slot="toast"]');
const check = (name, condition) => {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
};
const notify = (kind, message) =>
  page.evaluate(({ kind, message }) => window.frontendPreview.notifyAutoFill({ kind, message }), {
    kind,
    message,
  });
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await page.addStyleTag({ content: "#host-control{left:200px}" });
  await button("收起工作台").click();
  await notify("started", "已加入填表队列 #0–#9，每批 5 层");
  await toast.waitFor({ state: "visible" });
  check(
    "notice is visible with workbench closed",
    await page.locator("#ste-memory-notifications").evaluate((el) => el.matches(":popover-open")),
  );
  check("notice has title and floor range", (await toast.innerText()).includes("#0–#9"));
  check(
    "notification does not take focus",
    !(await page
      .locator("#ste-memory-notifications")
      .evaluate((el) => el.contains(document.activeElement))),
  );
  await page.mouse.move(10, 400);
  await toast.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/fill-notification-desktop.png` });
  await button("查看任务").click();
  await page.getByRole("heading", { name: "任务", exact: true }).waitFor();
  check(
    "action opens workbench on tasks",
    (await page.locator('[data-action="nav-tasks"]').getAttribute("aria-current")) === "page",
  );
  await toast.waitFor({ state: "detached" });

  await notify("reminder", "待填 #10–#19，共 10 层");
  await notify("reminder", "待填 #10–#24，共 15 层");
  check(
    "reminder range updates without duplication",
    (await toast.count()) === 1 && (await toast.innerText()).includes("15 层"),
  );
  await button("收起工作台").click();
  await button("打开预览").click();
  await button("查看任务").click();
  check(
    "notice action stays clickable above reopened workbench",
    (await page.locator('[data-action="nav-tasks"]').getAttribute("aria-current")) === "page",
  );
  await toast.waitFor({ state: "detached" });

  await page.setViewportSize({ width: 320, height: 640 });
  await notify("failed", `自动填表 #10–#24 停止：${"连接失败，请检查服务地址。".repeat(6)}`);
  await toast.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-slot="toast"]').getBoundingClientRect();
    return rect.x >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  check(
    "320px error text fits viewport",
    await toast.evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.keyboard.press("F6");
  check(
    "keyboard shortcut focuses notification region",
    await page
      .locator('[data-slot="toast-viewport"]')
      .evaluate((el) => el.contains(document.activeElement)),
  );
  check(
    "toast controls reset host styles",
    await button("查看任务").evaluate(
      (el) => getComputedStyle(el).backgroundColor !== "rgb(255, 192, 203)",
    ),
  );
  await page.screenshot({ path: `${screenshots}/fill-notification-320.png` });
  await button("关闭通知").click();
  await toast.waitFor({ state: "detached" });

  await notify("reminder", "待填 #0–#4，共 5 层");
  await toast.waitFor({ state: "visible" });
  await page.evaluate(() => window.frontendPreview.dismissAutoFillReminder());
  await toast.waitFor({ state: "detached" });
  check("scheduler can dismiss persistent reminder", (await toast.count()) === 0);
  await notify("started", "已加入填表队列 #0–#4，每批 5 层");
  await toast.waitFor({ state: "visible" });
  await page.evaluate(() => window.frontendPreview.switchChat("b"));
  await toast.waitFor({ state: "detached" });
  check("switching chat clears old notification", (await toast.count()) === 0);
  await page.evaluate(() =>
    window.frontendPreview.notifyAutoFill({
      kind: "failed",
      message: "旧对话错误",
      identity: "old-chat",
    }),
  );
  check("stale chat notification is ignored", (await toast.count()) === 0);

  await page.locator('[data-action="nav-records"]').click();
  await page.locator('[data-action="open-record"]').first().click();
  await page.locator('[data-action="edit-record"]').click();
  const name = page.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("通知跳转前的草稿");
  await notify("started", "已加入填表队列 #0–#4，每批 5 层");
  await button("查看任务").click();
  await button("保留编辑").click();
  check(
    "view tasks preserves unsaved edit guard",
    (await name.inputValue()) === "通知跳转前的草稿",
  );
  await notify("started", "已加入填表队列 #5–#9，每批 5 层");
  await button("查看任务").click();
  await button("放弃修改并继续").click();
  await page.getByRole("heading", { name: "任务", exact: true }).waitFor();
  check(
    "confirming leave continues toast navigation",
    (await page.locator('[data-action="nav-tasks"]').getAttribute("aria-current")) === "page",
  );

  await page.goto(`${process.env.FRONTEND_URL ?? "http://127.0.0.1:18825"}/?dark`);
  await notify("completed", "自动填表 #0–#9 已完成");
  await toast.waitFor({ state: "visible" });
  check(
    "notice follows dark theme",
    (await page.locator("#ste-memory-notifications").getAttribute("data-tone")) === "dark",
  );
  await toast.evaluate(async (el) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
  await page.screenshot({ path: `${screenshots}/fill-notification-dark.png` });
  await page.mouse.move(0, 0);
  await toast.waitFor({ state: "detached", timeout: 12000 });
  check("completion notice auto dismisses", (await toast.count()) === 0);
  check("no browser exceptions", errors.length === 0);
} finally {
  await browser.close();
}
