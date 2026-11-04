import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const failures = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
  if (!value) {
    failures.push(name);
  }
};
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });

try {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
    await page.locator('[data-action="nav-settings"]').click();
    await page.getByRole("button", { name: "表格预设", exact: true }).click();
    const rows = page.locator('[data-action="open-table-preset"]');
    await rows.first().click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出草稿", exact: true }).click(),
    ]);
    const stream = await download.createReadStream();
    let text = "";
    for await (const chunk of stream) {
      text += chunk.toString();
    }
    const exported = JSON.parse(text);
    await page.locator('[data-action="page-back"]').click();
    for (let index = 0; index < 16; index++) {
      exported.preset.name = `滚动验收预设 ${index + 1}`;
      await page.getByLabel("导入表格预设 JSON", { exact: true }).setInputFiles({
        name: "scroll-preset.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(exported)),
      });
      await page.waitForFunction(
        (count) =>
          window.frontendPreview.settingsSnapshot().tablePresets.userPresets.length === count,
        index + 1,
      );
    }
    const content = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", { name: "新空间默认", exact: true }),
      })
      .locator("..");
    const dimensions = await content.evaluate((el) => ({
      height: el.clientHeight,
      content: el.scrollHeight,
      sections: Array.from(el.querySelectorAll(":scope > section"), (section) => ({
        height: section.clientHeight,
        content: section.scrollHeight,
      })),
    }));
    console.log(JSON.stringify({ width, ...dimensions }));
    check(
      `${width}px sections retain full content height`,
      dimensions.sections.every((section) => section.height >= section.content - 1),
    );
    check(`${width}px page has scrollable overflow`, dimensions.content > dimensions.height);
    await content.evaluate((el) => {
      el.scrollTop = 0;
    });
    await content.hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(200);
    check(
      `${width}px wheel scrolls the preset list`,
      await content.evaluate((el) => el.scrollTop > 0),
    );
    await content.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    check(
      `${width}px final preset and import remain reachable`,
      await content.evaluate((el) => {
        const last = el.querySelectorAll('[data-action="open-table-preset"]');
        const input = el.querySelector('input[type="file"]');
        const bottom = el.getBoundingClientRect().bottom;
        return (
          last[last.length - 1].getBoundingClientRect().bottom <= bottom + 1 &&
          input.getBoundingClientRect().bottom <= bottom + 1
        );
      }),
    );
    await page.screenshot({ path: `${screenshots}/table-presets-scroll-${width}.png` });
    await rows.last().click();
    await page.locator('[data-action="page-back"]').click();
    check(
      `${width}px return restores list position`,
      await content.evaluate((el) => el.scrollTop > 0),
    );
    check(
      `${width}px no horizontal overflow`,
      await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
  }
  check("no browser exceptions", errors.length === 0);
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
