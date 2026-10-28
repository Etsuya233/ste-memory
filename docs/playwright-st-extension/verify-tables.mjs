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
const label = (name) => page.getByLabel(name, { exact: true });
const schema = () => page.evaluate(() => window.frontendPreview.schemaSnapshot());
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function save(kind) {
  await action(`save-${kind}`).click();
  await action(`save-${kind}`).waitFor({ state: "hidden" });
}
async function discard() {
  await action("cancel-edit").click();
  if (await page.getByRole("alertdialog").count()) await button("放弃修改并继续").click();
}
async function switchChat(key) {
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.tablesWorkspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour") &&
      !window.frontendPreview.tablesWorkspace.getSnapshot().loading,
    key,
  );
}
try {
  await page.goto(url);
  await action("nav-tables").click();
  await action("open-table").waitFor();
  check(
    "seed tables loaded",
    (await page.locator('[data-action="open-table"]:visible').count()) === 3,
  );
  await action("create-table").click();
  await label("名称").fill("预览事件");
  await label("Key").fill("preview_events");
  await action("cancel-edit").click();
  await button("保留编辑").waitFor();
  check(
    "dirty cancel focuses keep editing",
    await button("保留编辑").evaluate((el) => document.activeElement === el),
  );
  await button("保留编辑").click();
  await action("nav-records").click();
  await button("保留编辑").click();
  check("dirty navigation retains draft", (await label("名称").inputValue()) === "预览事件");
  await save("table");
  const created = (await schema()).tables.find((table) => table.key === "preview_events");
  check("table creation uses active chat", created?.memorySpaceId === "space-a");
  await button("编辑表格").click();
  await label("名称").fill("取消表名");
  await discard();
  check(
    "cancel table edit preserves data",
    (await schema()).tables.find((table) => table.id === created.id).name === "预览事件",
  );
  await button("编辑表格").click();
  await label("名称").fill("空间A草稿");
  await switchChat("b");
  await action("open-table").waitFor();
  await switchChat("a");
  check("chat return restores schema draft", (await label("名称").inputValue()) === "空间A草稿");
  await page.evaluate(() => window.frontendPreview.delayNextSchemaSave(600));
  await action("save-table").click();
  await switchChat("b");
  await page.waitForFunction(
    (id) =>
      window.frontendPreview.schemaSnapshot().tables.find((table) => table.id === id)?.name ===
      "空间A草稿",
    created.id,
  );
  check(
    "late schema save stays in original chat",
    !(await schema()).tables.some(
      (table) => table.memorySpaceId === "space-b" && table.key === "preview_events",
    ),
  );
  await switchChat("a");
  await button("新增字段").click();
  await label("名称").fill("标题");
  await label("Key").fill("title");
  await page.getByRole("switch", { name: "必填", exact: true }).click();
  await save("field");
  const field = (await schema()).fields.find(
    (field) => field.tableId === created.id && field.key === "title",
  );
  check("field creation persists required", field?.required);
  await page.getByRole("button", { name: /标题.*title/ }).click();
  check("field type immutable", await label("类型").isDisabled());
  await label("名称").fill("事件标题");
  await save("field");
  check(
    "field edit commits",
    (await schema()).fields.find((item) => item.id === field.id).name === "事件标题",
  );
  await button("新增字段").click();
  await label("名称").fill("重复标题");
  await label("Key").fill("title");
  await action("save-field").click();
  await page.getByText("同一表格内的字段 Key 不能重复", { exact: true }).waitFor();
  check("duplicate field key preserves draft", (await label("名称").inputValue()) === "重复标题");
  await discard();
  await button("新增字段").click();
  await label("名称").fill("取消字段");
  await label("Key").fill("cancelled");
  await discard();
  check(
    "cancel field preserves schema",
    !(await schema()).fields.some((field) => field.key === "cancelled"),
  );
  await button("新增字段").click();
  await label("名称").fill("目标地点");
  await label("Key").fill("destination");
  await label("类型").selectOption("single_reference");
  await action("save-field").click();
  check(
    "reference target required",
    await label("引用目标表").evaluate((el) => !el.validity.valid),
  );
  await label("引用目标表").selectOption("space-a-table-1");
  await save("field");
  check(
    "reference target persists",
    (await schema()).fields.some(
      (field) => field.tableId === created.id && field.referenceTableId === "space-a-table-1",
    ),
  );
  await page.getByRole("button", { name: /显示策略/ }).click();
  await label("显示字段").selectOption(field.id);
  await save("display");
  check(
    "display field saved",
    (await schema()).tables.find((table) => table.id === created.id).displayStrategy.fieldId ===
      field.id,
  );
  await page.getByRole("button", { name: /事件标题.*title/ }).click();
  await page.getByRole("switch", { name: "启用", exact: true }).click();
  await action("save-field").click();
  await page
    .getByText("请先指定不使用该字段的其他显示策略，再删除或停用该字段", { exact: true })
    .waitFor();
  check(
    "display field cannot be disabled",
    (await schema()).fields.find((item) => item.id === field.id).enabled,
  );
  await discard();
  await button("删除字段 事件标题").click();
  await button("确认删除").click();
  await page
    .getByRole("alertdialog")
    .getByText("请先指定不使用该字段的其他显示策略，再删除或停用该字段", { exact: true })
    .waitFor();
  await button("取消").click();
  check(
    "display dependency blocks delete",
    (await schema()).fields.some((item) => item.id === field.id),
  );
  await button("删除字段 目标地点").click();
  await button("取消").click();
  check(
    "field delete cancel preserves data",
    (await schema()).fields.some((item) => item.key === "destination"),
  );
  await button("删除字段 目标地点").click();
  await button("确认删除").click();
  await page.waitForFunction(
    () =>
      !window.frontendPreview.schemaSnapshot().fields.some((item) => item.key === "destination"),
  );
  check("field deletion commits", true);
  await button("删除表格").click();
  await button("取消").click();
  check(
    "table delete cancel preserves data",
    (await schema()).tables.some((item) => item.id === created.id),
  );
  await button("删除表格").click();
  await button("确认删除").click();
  await action("open-table").waitFor();
  check(
    "table deletion cascades fields",
    !(await schema()).fields.some((item) => item.tableId === created.id),
  );
  await page.locator('[data-action="open-table"]').filter({ hasText: "人物" }).click();
  await page.getByRole("button", { name: /显示策略/ }).click();
  await label("显示方式").selectOption("template");
  await label("显示模板").fill("角色：{name}");
  await button("预览当前草稿").click();
  await page.getByText("角色：爱丽丝", { exact: true }).waitFor();
  check("display preview uses real records", true);
  await save("display");
  await page.getByRole("button", { name: /向量索引 ·/ }).click();
  await page.getByRole("switch", { name: "启用向量索引", exact: true }).click();
  await button("预览当前草稿").click();
  await page.getByText("25 条记录 · 25 个向量目标 · 0 就绪 · 25 待建", { exact: true }).waitFor();
  await save("vector");
  check(
    "vector configuration persists",
    (await schema()).tables.find((table) => table.id === "space-a-table-0").vectorIndex.enabled,
  );
  await button("补建索引").click();
  await page.getByText("索引任务已提交，请在任务页查看进度", { exact: true }).waitFor();
  await button("清除向量").click();
  await button("确认删除").click();
  await page.getByText("向量已清除，记忆正文保留", { exact: true }).waitFor();
  check(
    "vector clear retains memory",
    await page.evaluate(
      () =>
        window.frontendPreview.snapshot().filter((record) => record.tableId === "space-a-table-0")
          .length === 25,
    ),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  check(
    "field entry isolates host CSS",
    await page
      .getByRole("button", { name: /名称.*name/ })
      .evaluate((el) => getComputedStyle(el).backgroundColor !== "rgb(255, 192, 203)"),
  );
  await page.screenshot({ path: `${screenshots}/tables-mobile-320.png` });
  check(
    "320px no horizontal overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  check(
    "mobile navigation visible",
    await action("nav-records").evaluate(
      (el) => el.getBoundingClientRect().bottom <= window.innerHeight,
    ),
  );
  await action("nav-records").click();
  await action("open-record").waitFor();
  check(
    "records usable after schema changes",
    (await page.locator('[data-action="open-record"]:visible').count()) === 20,
  );
  // Seed through the actual workspace/services, then exercise long pages through
  // the UI. This catches inherited offsets even when the normal fixture is short.
  await page.reload();
  await action("nav-tables").click();
  await action("open-table").waitFor();
  await page.evaluate(async () => {
    const workspace = window.frontendPreview.tablesWorkspace;
    for (let index = 0; index < 12; index++) {
      await workspace.selectTable(null);
      workspace.begin("table");
      const editor = workspace.getSnapshot().editor;
      workspace.change({
        ...editor,
        draft: {
          ...editor.draft,
          name: `滚动表 ${index}`,
          key: `scroll_${index}`,
          description: index === 11 ? "长表说明\n".repeat(80) : "",
        },
      });
      await workspace.save();
    }
    await workspace.selectTable(null);
    workspace.begin("table");
    workspace.discard();
  });
  const scrollArea = () => page.locator('[data-page-scroll="tables"]');
  async function scrollTo(top) {
    await scrollArea().evaluate((element, top) => (element.scrollTop = top), top);
    // Wait for native scroll events to be delivered before changing views.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    return scrollArea().evaluate((element) => element.scrollTop);
  }
  async function expectScroll(top) {
    await page.waitForFunction(
      (top) => Math.abs(document.querySelector('[data-page-scroll="tables"]').scrollTop - top) < 2,
      top,
    );
  }
  const listOffset = await scrollTo(10000);
  check("long table list scrolls", listOffset > 500);
  await page.locator('[data-action="open-table"]').filter({ hasText: "滚动表 11" }).click();
  await button("编辑表格").waitFor();
  await expectScroll(0);
  check("opening table starts at top", true);
  const detailOffset = await scrollTo(400);
  await action("nav-tasks").click();
  await action("nav-tables").click();
  await expectScroll(detailOffset);
  check("bottom navigation restores table offset", true);
  await action("page-back").click();
  await action("open-table").waitFor();
  await expectScroll(listOffset);
  check("table back restores list offset after loading", true);
  await page.locator('[data-action="open-table"]').filter({ hasText: "滚动表 11" }).click();
  await expectScroll(0);
  check("reopening table starts at top", true);
  await action("page-back").click();
  await page.locator('[data-action="open-table"]').filter({ hasText: "人物" }).click();
  await page.waitForFunction(() => !window.frontendPreview.tablesWorkspace.getSnapshot().loading);
  const displayButton = page.getByRole("button", { name: /显示策略/ });
  await displayButton.scrollIntoViewIfNeeded();
  const fieldsOffset = await scrollTo(await scrollArea().evaluate((element) => element.scrollTop));
  await displayButton.click();
  await expectScroll(0);
  check("opening editor starts at top", true);
  await action("cancel-edit").click();
  await expectScroll(fieldsOffset);
  check("editor back restores table detail offset", true);
  await switchChat("b");
  await action("open-table").waitFor();
  await expectScroll(0);
  check("different chat has independent offset", true);
  await switchChat("a");
  await button("编辑表格").waitFor();
  await expectScroll(fieldsOffset);
  check("chat return restores table detail offset", true);
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
