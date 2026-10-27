/** No ST/login/data required. First run build + scripts/preview-records.ts. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const url = process.env.RECORDS_URL ?? "http://127.0.0.1:8802";
const output =
  process.env.RECORDS_SCREENSHOTS ?? "../../node_modules/.cache/records-preview/screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function loaded() {
  await action("open-record").waitFor();
}
async function dialogResponse(accept) {
  page.once("dialog", (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
}
try {
  await page.goto(url);
  await loaded();
  check("initial records page", (await action("open-record").count()) === 1);
  check(
    "10 records per page",
    (await page.locator('[data-action="open-record"]:visible').count()) === 10,
  );
  check(
    "host control untouched",
    (await page.locator("#host-control").evaluate((el) => getComputedStyle(el).backgroundColor)) ===
      "rgb(255, 192, 203)",
  );
  await page.screenshot({ path: `${output}/desktop-light.png`, fullPage: true });
  await action("record-page-next").click();
  await page.waitForFunction(() => document.querySelector('[data-record-id="record-10"]'));
  check(
    "pagination next",
    (await page.locator('[data-record-id="record-10"]:visible').count()) === 1,
  );
  await action("record-page-prev").click();
  await page.locator('[data-record-id="record-0"]:visible').waitFor();
  await action("record-search-toggle").click();
  await action("record-search").fill("爱丽丝");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="open-record"]').length === 1,
  );
  check(
    "debounced search",
    await action("open-record")
      .textContent()
      .then((text) => text.includes("爱丽丝")),
  );
  await action("record-search").fill("");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="open-record"]').length === 10,
  );
  await action("record-sort-toggle").focus();
  await page.keyboard.press("Enter");
  await page.locator('[role="menu"]:visible').waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.locator('[role="menu"]:visible').waitFor({ state: "hidden" });
  check("sort menu Escape closes", (await page.locator('[role="menu"]:visible').count()) === 0);
  check(
    "sort menu restores focus",
    await action("record-sort-toggle").evaluate((el) => el === document.activeElement),
  );
  await page.locator('[data-record-id="record-0"]:visible').click();
  await action("evidence-floor-jump").waitFor();
  await action("evidence-floor-jump").hover();
  await page.getByRole("tooltip").waitFor();
  check("evidence excerpt", (await page.getByRole("tooltip").textContent()).includes("雨后的街角"));
  await action("evidence-floor-jump").click();
  check(
    "evidence floor adapter",
    await page.evaluate(() => window.recordsPreview.events.includes("jump:7")),
  );
  await action("edit-record").click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("草稿不应丢失");
  await dialogResponse(false);
  await action("cancel-record").click();
  check(
    "cancel dismissal preserves draft",
    (await page.getByRole("textbox", { name: "名称", exact: true }).inputValue()) ===
      "草稿不应丢失",
  );
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("爱丽丝（已编辑）");
  await action("save-record").click();
  await action("edit-record").waitFor();
  check(
    "update committed with disabled field preserved",
    await page.evaluate(() => {
      const r = window.recordsPreview.snapshot().find((r) => r.id === "record-0");
      return r.payload.name === "爱丽丝（已编辑）" && r.payload.legacy === "保留的历史字段";
    }),
  );
  check("history retained", (await page.getByRole("button", { name: /修订历史/ }).count()) > 0);
  await page.screenshot({ path: `${output}/desktop-detail.png`, fullPage: true });
  await dialogResponse(false);
  await action("delete-record").click();
  check(
    "delete cancel retains record",
    await page.evaluate(() => window.recordsPreview.snapshot().some((r) => r.id === "record-0")),
  );
  await action("back-to-records").click();
  await loaded();
  await action("add-grid-row").click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("新增验收记录");
  await action("save-record").click();
  await page.waitForFunction(() => window.recordsPreview.events.includes("create"));
  check(
    "create committed",
    await page.evaluate(() =>
      window.recordsPreview.snapshot().some((r) => r.displayText === "新增验收记录"),
    ),
  );
  await action("delete-record").waitFor();
  await dialogResponse(true);
  await action("delete-record").click();
  await page.waitForFunction(() => window.recordsPreview.events.includes("delete"));
  check(
    "confirmed delete removes only selected record",
    await page.evaluate(
      () =>
        !window.recordsPreview.snapshot().some((r) => r.displayText === "新增验收记录") &&
        window.recordsPreview.snapshot().some((r) => r.id === "record-0"),
    ),
  );
  await loaded();
  await action("records-grid-view").click();
  await page.locator('[data-grid-row="existing"]').first().waitFor();
  check("grid existing rows", (await page.locator('[data-grid-row="existing"]').count()) === 10);
  await action("add-grid-row").click();
  const newRow = page.locator('[data-grid-row="new"]');
  await newRow.getByRole("textbox", { name: "名称", exact: true }).fill("批量新增");
  await newRow.getByRole("switch", { name: "活跃", exact: true }).click();
  await newRow.getByRole("listbox", { name: "标签", exact: true }).selectOption(["朋友", "同伴"]);
  await dialogResponse(false);
  await page.locator('[data-action="select-table"][data-table-id="table-1"]').click();
  check("dirty switch cancellation preserves new row", (await newRow.count()) === 1);
  await action("save-grid").click();
  await page.waitForFunction(() =>
    window.recordsPreview.snapshot().some((r) => r.displayText === "批量新增"),
  );
  check(
    "grid save retains boolean and multi-select",
    await page.evaluate(() => {
      const row = window.recordsPreview.snapshot().find((r) => r.displayText === "批量新增");
      return row.payload.active === true && row.payload.tags.length === 2;
    }),
  );
  await newRow.waitFor({ state: "detached" });
  await page.locator('[data-action="select-table"][data-table-id="table-2"]').click();
  await page.getByText("还没有记录", { exact: true }).waitFor();
  check("empty table state", true);
  await page.locator('[data-action="select-table"][data-table-id="table-2"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.getByText("旧港口", { exact: true }).waitFor();
  check("table tabs keyboard navigation", true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}/?dark`);
  await loaded();
  await page.screenshot({ path: `${output}/mobile-dark.png`, fullPage: true });
  check(
    "mobile no document horizontal overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await action("record-sort-toggle").click();
  await page.locator('[role="menu"]:visible').waitFor();
  await page.screenshot({ path: `${output}/mobile-dark-menu.png`, fullPage: true });
  check(
    "mobile menu inside viewport",
    await page.locator('[role="menu"]:visible').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }),
  );
  await page.keyboard.press("Escape");
  check("no browser exceptions", errors.length === 0);
  console.log(`Screenshots: ${output}`);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
