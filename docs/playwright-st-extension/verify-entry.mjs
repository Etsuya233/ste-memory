import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
// Exercise global settings in this browser without writing the user's ST settings file.
await page.route("**/api/settings/save", (route) => route.fulfill({ json: { result: "ok" } }));
const panel = page.locator("#ste-memory-app");
const top = page.locator("#ste-memory-top-entry [role=button]");
const wand = page.locator("#ste-memory-wand-entry");
const check = (name, result) => {
  assert.ok(result, name);
  console.log(`PASS ${name}`);
};
async function appearance(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: style.opacity,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      padding: style.padding,
      textShadow: style.textShadow,
      transition: style.transition,
    };
  });
}
async function close() {
  await panel.locator('[data-action="close-frontend"]').click();
  await panel.waitFor({ state: "hidden" });
}
try {
  await page.goto(process.env.ST_URL ?? "http://127.0.0.1:8000");
  await page.waitForFunction(() => window.__STE_MEMORY_RUNTIME__);
  await page.locator('[data-action="open-frontend"]').first().waitFor();
  await page.locator('[data-action="open-frontend"]').first().click();
  await panel.locator('[data-action="nav-settings"]').click();
  const placement = panel.getByLabel("入口位置", { exact: true });
  await placement.selectOption("top");
  await close();
  await page.mouse.move(0, 500);
  const native = page.locator("#leftNavDrawerIcon");
  await page.waitForTimeout(600);
  check(
    "top icon inherits ST's size, font, opacity, shadow and transition",
    JSON.stringify(await appearance(top)) === JSON.stringify(await appearance(native)),
  );
  await top.hover();
  await page.waitForTimeout(600);
  check("top hover follows ST opacity", (await appearance(top)).opacity === "1");
  await top.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "visible" });
  check(
    "keyboard opens the panel with the native active icon",
    await top.evaluate((element) => element.classList.contains("openIcon")),
  );
  await placement.selectOption("wand");
  check(
    "wand placement removes the top entry immediately",
    (await top.count()) === 0 && (await wand.count()) === 1,
  );
  await close();
  await page.locator("#extensionsMenuButton").click();
  await wand.waitFor({ state: "visible" });
  await page.mouse.move(0, 500);
  check("wand item inherits ST menu opacity", (await appearance(wand)).opacity === "0.5");
  await wand.hover();
  check("wand hover follows ST menu opacity", (await appearance(wand)).opacity === "1");
  await wand.focus();
  await page.keyboard.press("Space");
  await panel.waitFor({ state: "visible" });
  await page.locator("#extensionsMenu").waitFor({ state: "hidden" });
  check("keyboard opens from wand and closes the ST menu", await panel.isVisible());
  await close();
  check(
    "closing restores focus to the visible wand button",
    await page
      .locator("#extensionsMenuButton")
      .evaluate((element) => document.activeElement === element),
  );
  await page.keyboard.press("Enter");
  await wand.waitFor({ state: "visible" });
  await wand.evaluate((element) => {
    element.dataset.clicks = "0";
    element.addEventListener("click", () => {
      element.dataset.clicks = String(Number(element.dataset.clicks) + 1);
    });
  });
  await wand.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "visible" });
  check(
    "Enter activates once alongside ST's keyboard handler",
    (await wand.getAttribute("data-clicks")) === "1",
  );
  await placement.selectOption("both");
  check(
    "both placements share the open panel state",
    (await top.getAttribute("aria-expanded")) === "true" &&
      (await wand.getAttribute("aria-expanded")) === "true",
  );
  await close();
  await top.click();
  await close();
  check(
    "closing restores focus to the top launcher",
    await top.evaluate((element) => document.activeElement === element),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#extensionsMenuButton").click();
  await wand.click();
  await panel.waitFor({ state: "visible" });
  check("wand opens the same panel on mobile", await panel.isVisible());
  await close();
  await page.locator("#extensionsMenuButton").click();
  await wand.waitFor({ state: "visible" });
  const screenshots =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/st-entry-mobile.png` });
  check(
    "entry setting is stored through the existing service",
    await page.evaluate(
      () => window.__STE_MEMORY_RUNTIME__.settings.read().entryPlacement === "both",
    ),
  );
  check("no uncaught browser errors", errors.length === 0);
} finally {
  await browser.close();
}
