import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const table = page.getByRole("table", { name: "记录表格", exact: true });
const scroll = () => page.locator('[data-slot="records-scroll"]:visible');
const cell = (id, field) => table.locator(`[data-record-id="${id}"][data-record-field="${field}"]`);
const position = () => scroll().evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function settled() {
  await page.waitForFunction(() => !window.frontendPreview.workspace.getSnapshot().listLoading);
}
async function back() {
  await action("back-to-records").click();
  await table.waitFor();
}
async function switchChat(key) {
  await page.getByLabel("预览对话", { exact: true }).selectOption(key);
  await page.waitForFunction((key) => {
    const state = window.frontendPreview.workspace.getSnapshot();
    return state.context?.spaceId === `space-${key}` && !state.listLoading;
  }, key);
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("open-record").waitFor();
  check(
    "initial view remains the list",
    (await page.getByRole("tab", { name: "列表", exact: true }).getAttribute("aria-selected")) ===
      "true",
  );
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await table.waitFor();
  check(
    "toolbar uses icon-only tabs beside the table selector",
    await page.getByRole("tablist", { name: "记录展示方式" }).evaluate((el) => {
      const select = document.querySelector("#ste-record-table").getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      return (
        el.textContent.trim() === "" &&
        Math.abs((bounds.top + bounds.bottom) / 2 - (select.top + select.bottom) / 2) < 2 &&
        !document.querySelector('label[for="ste-record-table"]')
      );
    }),
  );
  check(
    "table viewport has rounded corners",
    await scroll().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) > 0),
  );
  check(
    "selected view indicator is circular and fits within the track",
    await page.getByRole("tab", { name: "表格", exact: true }).evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const track = el.parentElement.getBoundingClientRect();
      return (
        Math.abs(bounds.width - bounds.height) < 1 &&
        bounds.top - track.top >= 3 &&
        track.bottom - bounds.bottom >= 3
      );
    }),
  );
  check(
    "table uses the same twenty records and configured field order",
    (await table.locator("tbody tr").count()) === 20 &&
      JSON.stringify(await table.locator("thead th").allTextContents()) ===
        JSON.stringify([
          "#",
          "名称",
          "描述",
          "活跃",
          "身份",
          "标签",
          "相遇次数",
          "最近见面",
          "常去地点",
          "旧备注已停用",
          "操作",
        ]),
  );
  check(
    "reference values use labels and disabled fields stay visible",
    (await cell("space-a-record-0", "place").innerText()) === "雨巷书店" &&
      (await cell("space-a-record-0", "active").innerText()) === "是" &&
      (await cell("space-a-record-0", "tags").innerText()) === "朋友" &&
      (await cell("space-a-record-0", "legacy").innerText()).includes("停用字段"),
  );
  await page.evaluate(() =>
    window.frontendPreview.patchSortingRecords([
      { id: "space-a-record-0", payload: { notes: "很长的描述\n".repeat(20) } },
    ]),
  );
  await settled();
  check(
    "long text clamps to three lines",
    await cell("space-a-record-0", "notes")
      .locator("span")
      .evaluate(
        (el) =>
          getComputedStyle(el).webkitLineClamp === "3" &&
          el.scrollHeight > el.clientHeight &&
          el.clientHeight <= 61,
      ),
  );
  check(
    "short cell buttons fill the height set by long text in the same row",
    await cell("space-a-record-0", "name").evaluate((el) => {
      const target = el.getBoundingClientRect();
      const container = el.parentElement.getBoundingClientRect();
      return (
        Math.abs(target.height - container.height) <= 2 &&
        Math.abs(target.width - container.width) <= 2
      );
    }),
  );
  check(
    "row number and pinned edit buttons fill the cell too",
    await table
      .locator("tbody tr")
      .first()
      .locator("button")
      .evaluateAll(
        (elements) =>
          elements.length > 0 &&
          elements.every((el) => {
            const target = el.getBoundingClientRect();
            const container = el.parentElement.getBoundingClientRect();
            return (
              Math.abs(target.height - container.height) <= 2 &&
              Math.abs(target.width - container.width) <= 2
            );
          }),
      ),
  );
  const nameCell = cell("space-a-record-0", "name");
  const bounds = await nameCell.boundingBox();
  const bottom = { x: bounds.width - 8, y: bounds.height - 5 };
  await nameCell.hover({ position: bottom });
  check(
    "hover reaches the bottom of a short-text cell",
    await nameCell.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.right - 8, rect.bottom - 5);
      return (
        el.matches(":hover") &&
        getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" &&
        el.contains(hit)
      );
    }),
  );
  check(
    "hover background paints through the button border to the cell edges",
    await table
      .locator("tbody tr")
      .first()
      .locator("button")
      .evaluateAll(
        (elements) =>
          elements.length > 0 &&
          elements.every((el) => {
            const style = getComputedStyle(el);
            return (
              style.backgroundClip === "border-box" ||
              [
                style.borderTopWidth,
                style.borderRightWidth,
                style.borderBottomWidth,
                style.borderLeftWidth,
              ].every((width) => parseFloat(width) === 0)
            );
          }),
      ),
  );
  await nameCell.click({ position: bottom });
  await action("save-record").waitFor();
  check(
    "clicking the bottom blank area edits the record",
    (await page.getByLabel("名称", { exact: true }).inputValue()) === "爱丽丝",
  );
  await back();
  await scroll().evaluate((el) => {
    el.scrollTop = 200;
    el.scrollLeft = 480;
  });
  await page.waitForFunction(
    () => document.querySelector('[data-slot="records-scroll"]').scrollTop === 200,
  );
  const sticky = await table.evaluate((el) => {
    const viewport = el.parentElement.getBoundingClientRect();
    const head = el.querySelector("thead th").getBoundingClientRect();
    const row = el.querySelector("tbody th").getBoundingClientRect();
    return (
      Math.abs(viewport.top - head.top) < 2 &&
      Math.abs(viewport.left - head.left) < 2 &&
      Math.abs(viewport.left - row.left) < 2
    );
  });
  check("header and row numbers stay fixed during two-axis scrolling", sticky);
  for (const left of [0, 480, 100000]) {
    await scroll().evaluate((el, left) => {
      el.scrollLeft = left;
    }, left);
    check(
      `edit column stays at the right edge at scroll ${left}`,
      await table.evaluate((el) => {
        const viewport = el.parentElement.getBoundingClientRect();
        const head = el.querySelector("thead th:last-child").getBoundingClientRect();
        const edit = el.querySelector("tbody td:last-child").getBoundingClientRect();
        return (
          Math.abs(viewport.right - head.right) <= 2 &&
          Math.abs(viewport.right - edit.right) <= 2 &&
          el.querySelector('[data-record-field="edit"] svg')
        );
      }),
    );
  }
  await scroll().evaluate((el) => {
    el.scrollLeft = 480;
  });
  const target = cell("space-a-record-4", "notes");
  await target.scrollIntoViewIfNeeded();
  const before = await position();
  await target.click();
  await action("save-record").waitFor();
  check(
    "cell opens directly in editor",
    (await page.getByRole("heading", { name: "编辑记录", exact: true }).count()) === 1,
  );
  check("editing hides the browsing surface", await table.isHidden());
  await page.getByLabel("描述", { exact: true }).focus();
  await page.evaluate(() => window.frontendPreview.workspace.refresh());
  check(
    "background refresh preserves the active editor field",
    await page.getByLabel("描述", { exact: true }).evaluate((el) => document.activeElement === el),
  );
  await back();
  check(
    "back restores both axes and the clicked cell focus",
    JSON.stringify(await position()) === JSON.stringify(before) &&
      (await target.evaluate((el) => document.activeElement === el)),
  );
  await action("nav-tables").click();
  await action("nav-records").click();
  await table.waitFor();
  check(
    "navigation retains table mode and both scroll positions",
    JSON.stringify(await position()) === JSON.stringify(before),
  );
  await switchChat("b");
  check("another chat starts in list mode", await action("open-record").isVisible());
  await switchChat("a");
  await table.waitFor();
  check(
    "A to B to A restores table and its position",
    JSON.stringify(await position()) === JSON.stringify(before),
  );
  await cell("space-a-record-4", "notes").click();
  await page.getByLabel("描述", { exact: true }).fill("表格入口编辑后保存");
  await action("nav-tables").click();
  await button("保留编辑").click();
  check(
    "direct editor keeps the shared unsaved-change guard",
    await action("save-record").isVisible(),
  );
  await page.evaluate(() => window.frontendPreview.failNextSave());
  await action("save-record").click();
  await page.getByText("尚未保存", { exact: true }).waitFor();
  check(
    "save failure retains the draft",
    (await page.getByLabel("描述", { exact: true }).inputValue()) === "表格入口编辑后保存",
  );
  await action("save-record").click();
  await action("edit-record").waitFor();
  await back();
  check(
    "saved field refreshes in the table",
    (await cell("space-a-record-4", "notes").innerText()) === "表格入口编辑后保存",
  );
  await button("下一页").click();
  await settled();
  check(
    "pagination shares records and uses absolute row numbers",
    (await table.locator("tbody tr").count()) === 5 &&
      (await table.locator("tbody th").first().innerText()) === "21",
  );
  await table.locator("tbody th button").first().click();
  await action("save-record").waitFor();
  await back();
  check(
    "editing on page two preserves paging",
    (await table.locator("tbody th").first().innerText()) === "21",
  );
  await action("record-sort").click();
  await page.locator('[data-sort-field="count"]:visible').click();
  await settled();
  check(
    "table uses full-set sort and returns to page one",
    (await table.locator("tbody tr").count()) === 20 &&
      (await table
        .locator("tbody tr")
        .first()
        .locator('[data-record-field="name"]')
        .innerText()) === "旅人 01",
  );
  await page.getByLabel("搜索记录", { exact: true }).fill("没有这种记录");
  await page.getByText("没有匹配的记录", { exact: true }).waitFor();
  check("search empty state works in table mode", (await table.count()) === 0);
  await page.getByLabel("搜索记录", { exact: true }).fill("");
  await table.waitFor();
  await page.getByLabel("记忆表格", { exact: true }).selectOption("space-a-table-2");
  await page.getByText("还没有记录", { exact: true }).waitFor();
  check("empty table keeps creation available", await action("create-record").isEnabled());
  await page.getByLabel("记忆表格", { exact: true }).selectOption("space-a-table-0");
  await table.waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    check(
      `${width}px confines horizontal overflow to the table`,
      (await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth)) &&
        (await scroll().evaluate((el) => el.scrollWidth > el.clientWidth)),
    );
    await table.locator('[data-record-field="edit"]').first().click();
    await action("save-record").waitFor();
    check(
      `${width}px supports direct editing`,
      await page.getByLabel("名称", { exact: true }).isVisible(),
    );
    await back();
  }
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await action("open-record").click();
  await action("edit-record").waitFor();
  check(
    "list entries still open the detail page",
    await page.getByRole("heading", { name: "记录详情", exact: true }).isVisible(),
  );
  await action("back-to-records").click();
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-label") ===
      "表格",
  );
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/record-table-320.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${directory}/record-table-desktop.png` });
  await button("切换亮暗色").click();
  await page.screenshot({ path: `${directory}/record-table-desktop-dark.png` });
  check("no table browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
