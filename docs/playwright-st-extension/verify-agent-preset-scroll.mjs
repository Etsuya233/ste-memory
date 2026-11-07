import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const content = () =>
  page
    .locator("#ste-memory-app div")
    .filter({ has: page.locator(":scope > section") })
    .last();
async function checkScroll(label) {
  const layout = await content().evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clipped: [...element.querySelectorAll(":scope > section")]
      .map((section) => ({
        title: section.querySelector("h2")?.textContent,
        height: section.clientHeight,
        content: section.scrollHeight,
      }))
      .filter((section) => section.content > section.height + 1),
  }));
  console.log(label, layout);
  check(`${label}: sections keep their full content height`, layout.clipped.length === 0);
  check(`${label}: page has a bounded scrolling area`, layout.scrollHeight > layout.height);
  await content().hover();
  await page.mouse.wheel(0, 5000);
  await page.waitForFunction(() => {
    const input = document.querySelector("#import-agent-preset");
    const rect = input.getBoundingClientRect();
    const bounds = input.closest("section").parentElement.getBoundingClientRect();
    return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  });
  check(`${label}: wheel reaches import control`, true);
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825", {
    timeout: 30000,
    waitUntil: "domcontentloaded",
  });
  await action("nav-settings").click();
  await page.getByRole("button", { name: "Agent 提示词预设", exact: true }).click();
  for (let index = 0; index < 12; index++) {
    await page.getByLabel("导入 Agent 预设 JSON", { exact: true }).setInputFiles({
      name: "scroll-preset.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "ste-memory-agent-preset",
          version: 2,
          exportedAt: "2026-11-07T00:00:00.000Z",
          preset: {
            id: `scroll-${index}`,
            name: `滚动预设 ${index}`,
            messages: [
              {
                id: "message",
                name: "正文",
                role: "system",
                enabled: true,
                content: "{{tablesDigest}}\n" + "长提示词内容\n".repeat(100),
              },
            ],
          },
        }),
      ),
    });
    await page.waitForFunction(
      (name) =>
        window.frontendPreview
          .settingsSnapshot()
          .agentPresets.presets.some((preset) => preset.name === name),
      `滚动预设 ${index}`,
    );
  }
  await page.screenshot({ path: `${screenshots}/agent-preset-list-320.png` });
  await checkScroll("320px preset list");
  await page.setViewportSize({ width: 1280, height: 900 });
  await checkScroll("desktop preset list");
  await page.screenshot({ path: `${screenshots}/agent-preset-list-desktop.png` });
  await page
    .locator('[data-action="open-agent-preset"]')
    .filter({ hasText: "滚动预设 11" })
    .click();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
    const editorContent = page.locator("#settings-agent-preset").locator("..");
    check(
      `${width}px editor has a bounded scrolling area`,
      await editorContent.evaluate((element) => element.scrollHeight > element.clientHeight),
    );
    await page.getByLabel("预览剧情输入", { exact: true }).scrollIntoViewIfNeeded();
    check(
      `${width}px editor preview input can be reached`,
      await page.getByLabel("预览剧情输入", { exact: true }).isVisible(),
    );
    check(
      `${width}px editor save bar remains in view`,
      await action("save-changes").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }),
    );
  }
  await page.getByRole("button", { name: "展开预览", exact: true }).click();
  const lastPreview = page.locator("#settings-agent-preset pre").last();
  await lastPreview.waitFor();
  const editorContent = page.locator("#settings-agent-preset").locator("..");
  await editorContent.hover();
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => {
    const form = document.querySelector("#settings-agent-preset");
    const scroller = form.parentElement;
    const preview = [...form.querySelectorAll("pre")].at(-1).getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    return preview.bottom <= bounds.bottom + 1;
  });
  check("long expanded preview scrolls to its final line", true);
  await page.screenshot({ path: `${screenshots}/agent-preset-preview-320.png` });
  await action("page-back").click();
  await page.waitForFunction(() => {
    const input = document.querySelector("#import-agent-preset");
    const content = input.closest("section").parentElement;
    return content.scrollTop > 0;
  });
  check("returning to list restores scroll position", true);
  check("no browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
