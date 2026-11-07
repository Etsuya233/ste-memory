import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";

const browser = await (process.env.ENGINE === "webkit"
  ? webkit.launch({ headless: true })
  : chromium.launch({ executablePath: process.env.CHROME, headless: true }));
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("open-record").click();
  await action("edit-record").click();
  assert.ok(
    await action("save-record").evaluate((button) =>
      button.form !== null && button.closest("form") === button.form &&
      !button.hasAttribute("form"),
    ),
    "record save uses its ancestor form without an external form association",
  );
  for (const width of [320, 390, 1100]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page.locator('[data-stm-field="record-value-date"], [data-stm-field="record-value-datetime"]')
        .evaluateAll((inputs) => inputs.every((input) =>
          getComputedStyle(input).appearance === "none" &&
          input.getBoundingClientRect().width <= input.parentElement.clientWidth &&
          input.scrollWidth <= input.clientWidth,
        )),
      `date controls fit their fields at ${width}px`,
    );
    if (width === 320) {
      const directory = new URL("../../node_modules/.cache/frontend-preview/screenshots/", import.meta.url);
      await mkdir(directory, { recursive: true });
      await page.locator('[data-stm-field="record-value-datetime"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: fileURLToPath(new URL("record-editor-320.png", directory)) });
    }
  }
  const name = page.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("");
  await action("save-record").click();
  await page.getByText("请填写「名称」", { exact: true }).waitFor();
  await name.fill("按钮保存");
  await action("save-record").click();
  await action("edit-record").waitFor();
  assert.equal(await page.evaluate(() => window.frontendPreview.snapshot()[0].payload.name), "按钮保存");
  await action("edit-record").click();
  await name.fill("回车保存");
  await name.press("Enter");
  await action("edit-record").waitFor();
  assert.equal(await page.evaluate(() => window.frontendPreview.snapshot()[0].payload.name), "回车保存");
  assert.deepEqual(errors, []);
  console.log("PASS record editor: native form ownership, date widths, validation, click and Enter saves");
} finally {
  await browser.close();
}
