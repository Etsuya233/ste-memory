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
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const snapshot = () => page.evaluate(() => window.frontendPreview.snapshot());
async function switchChat(key) {
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.workspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour") &&
      !window.frontendPreview.workspace.getSnapshot().listLoading,
    key,
  );
}
try {
  await page.goto(url);
  await action("open-record").waitFor();
  check(
    "20 records on first page",
    (await page.locator('[data-action="open-record"]:visible').count()) === 20,
  );
  check(
    "host CSS unchanged",
    (await page.locator("#host-control").evaluate((el) => getComputedStyle(el).backgroundColor)) ===
      "rgb(255, 192, 203)",
  );
  await page.screenshot({ path: `${screenshots}/mobile-list.png` });
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.locator('[data-record-id="space-a-record-20"]:visible').waitFor();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.locator('[data-record-id="space-a-record-0"]:visible').click();
  await action("edit-record").waitFor();
  check(
    "detail route replaces list",
    (await page.locator('[data-action="open-record"]:visible').count()) === 0,
  );
  await page.getByRole("button", { name: "查看楼层 7 的证据" }).hover();
  await page.getByRole("tooltip").waitFor();
  check(
    "evidence tooltip has accessible description",
    await page
      .getByRole("tooltip")
      .textContent()
      .then((text) => text.includes("地图")),
  );
  await page.mouse.move(2, 2);
  await action("edit-record").click();
  const name = page.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("保留的草稿");
  await action("cancel-edit").click();
  await page.getByRole("alertdialog").waitFor();
  check(
    "leave dialog focuses keep editing",
    await page
      .getByRole("button", { name: "保留编辑", exact: true })
      .evaluate((el) => document.activeElement === el),
  );
  await page.getByRole("button", { name: "保留编辑", exact: true }).click();
  check("cancel retains draft", (await name.inputValue()) === "保留的草稿");
  await switchChat("b");
  await page.locator('[data-record-id="space-b-record-0"]:visible').waitFor();
  check(
    "switched chat has its own records",
    await page
      .getByTestId("chat-title")
      .textContent()
      .then((text) => text.includes("旧港")),
  );
  await switchChat("a");
  check("returning restores original chat draft", (await name.inputValue()) === "保留的草稿");
  await page.evaluate(() => window.frontendPreview.failNextSave());
  await action("save-record").click();
  await page.getByText(/模拟保存失败/).waitFor();
  check("failed save preserves values", (await name.inputValue()) === "保留的草稿");
  await name.fill("爱丽丝（已编辑）");
  await action("save-record").click();
  await action("edit-record").waitFor();
  check(
    "save commits and keeps disabled payload",
    (await snapshot()).some(
      (r) =>
        r.id === "space-a-record-0" &&
        r.payload.name === "爱丽丝（已编辑）" &&
        r.payload.legacy === "这段停用字段内容应始终保留",
    ),
  );
  await page.screenshot({ path: `${screenshots}/mobile-detail.png` });
  await action("edit-record").click();
  await name.fill("切换期间保存");
  await page.evaluate(() => window.frontendPreview.delayNextSave(600));
  await action("save-record").click();
  await switchChat("b");
  await page.waitForFunction(() =>
    window.frontendPreview
      .snapshot()
      .some((r) => r.id === "space-a-record-0" && r.payload.name === "切换期间保存"),
  );
  check(
    "late save stays in original chat",
    (await snapshot()).some((r) => r.id === "space-b-record-0" && r.payload.name === "林舟"),
  );
  check("late save does not open detail in new chat", (await action("edit-record").count()) === 0);
  await switchChat("a");
  await action("edit-record").waitFor();
  await action("back-to-records").click();
  await action("create-record").click();
  await name.fill("新增旅人");
  await page.getByRole("switch", { name: "活跃", exact: true }).click();
  await page.getByRole("checkbox", { name: "同伴", exact: true }).click();
  await action("save-record").click();
  await action("edit-record").waitFor();
  check(
    "new record retains typed values",
    (await snapshot()).some(
      (r) =>
        r.displayText === "新增旅人" &&
        r.payload.active === true &&
        r.payload.tags.includes("同伴"),
    ),
  );
  await action("back-to-records").click();
  await action("create-record").click();
  await name.fill("只创建一次");
  await page.evaluate(() => window.frontendPreview.failNextPersistence());
  await action("save-record").click();
  await page.getByText("记录已提交，写回尚未完成", { exact: true }).waitFor();
  check("committed write failure ends editing", (await action("save-record").count()) === 0);
  await action("retry-persistence").click();
  await page.getByText("记录已提交，写回尚未完成", { exact: true }).waitFor({ state: "hidden" });
  check(
    "persistence retry does not create duplicates",
    (await snapshot()).filter((r) => r.displayText === "只创建一次").length === 1,
  );
  await action("back-to-records").click();
  const search = page.getByRole("searchbox", { name: "搜索记录" });
  await search.fill("旅人 15");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="open-record"]').length === 1,
  );
  await page.locator('[data-record-id="space-a-record-15"]:visible').click();
  await action("back-to-records").click();
  check(
    "return restores list focus",
    await page
      .locator('[data-record-id="space-a-record-15"]')
      .evaluate((el) => el === document.activeElement),
  );
  check("return keeps list search", (await search.inputValue()) === "旅人 15");
  await search.fill("");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="open-record"]').length === 20,
  );
  await page.locator('[data-record-id="space-a-record-0"]').click();
  await action("edit-record").click();
  await name.fill("冲突中的草稿");
  await page.evaluate(() => window.frontendPreview.changeRecord());
  await action("save-record").click();
  await page.getByText("记录已变化，草稿已保留").waitFor();
  check("revision conflict preserves draft", (await name.inputValue()) === "冲突中的草稿");
  await action("cancel-edit").click();
  await page.getByRole("button", { name: "放弃修改并继续" }).click();
  await action("back-to-records").click();
  await page
    .getByRole("combobox", { name: "记忆表格", exact: true })
    .selectOption("space-a-table-2");
  await page.getByText("还没有记录", { exact: true }).waitFor();
  check("empty table state", true);
  await page.setViewportSize({ width: 320, height: 640 });
  check(
    "small mobile no overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.goto(`${url}/?dark`);
  await action("open-record").waitFor();
  await page.screenshot({ path: `${screenshots}/mobile-dark.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${screenshots}/desktop-dark.png` });
  check("desktop keeps single page flow", (await action("edit-record").count()) === 0);
  check("no browser exceptions", errors.length === 0);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
