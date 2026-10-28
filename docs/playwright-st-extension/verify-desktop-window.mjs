import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (cause) => errors.push(cause.message));
page.setDefaultTimeout(10000);
const panel = page.locator("#ste-memory-app");
const header = panel.locator("[data-window-drag]");
const nav = panel.getByRole("navigation", { name: "工作台页面" });
const box = () => panel.boundingBox();
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const near = (a, b) => Math.abs(a - b) <= 2;
async function drag(locator, dx, dy) {
  const area = await locator.boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + dx, area.y + area.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await panel.locator('[data-action="open-record"]').first().waitFor();
  const initial = await box();
  const navigation = await nav.boundingBox();
  check(
    "desktop starts centered with a left navigation rail",
    near(initial.width, 960) &&
      near(initial.x, 240) &&
      near(navigation.x, initial.x + 1) &&
      navigation.width < 90,
  );
  const navButtons = await nav.getByRole("button").evaluateAll((elements) =>
    elements.map((element) => {
      const { y, height } = element.getBoundingClientRect();
      return { y, height };
    }),
  );
  check(
    "desktop navigation keeps compact button sizes stacked from the top",
    navButtons.every(
      (item, index) =>
        near(item.height, 56) && (index === 0 || near(item.y - navButtons[index - 1].y, 60)),
    ),
  );
  await drag(header.locator("h1"), 70, -10);
  let current = await box();
  check(
    "page title drags the window",
    near(current.x, initial.x + 70) && near(current.y, initial.y - 10),
  );
  await drag(panel.locator('[data-window-resize="se"]'), 100, -100);
  let resized = await box();
  check(
    "corner resizes both dimensions",
    near(resized.width, current.width + 100) && near(resized.height, current.height - 100),
  );
  await drag(panel.locator('[data-window-resize="w"]'), 40, 0);
  current = await box();
  check(
    "left edge preserves the opposite edge",
    near(current.x, resized.x + 40) && near(current.x + current.width, resized.x + resized.width),
  );
  await drag(panel.locator('[data-window-resize="n"]'), 0, 40);
  resized = await box();
  check(
    "top edge preserves the bottom",
    near(resized.y, current.y + 40) && near(resized.y + resized.height, current.y + current.height),
  );
  await header.locator("h1").dblclick();
  current = await box();
  check(
    "double click restores default bounds",
    near(current.x, initial.x) &&
      near(current.width, initial.width) &&
      near(current.height, initial.height),
  );
  await header.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  current = await box();
  check(
    "keyboard moves and resizes the same window",
    near(current.x, initial.x + 16) && near(current.width, initial.width - 16),
  );
  await panel.locator('[data-action="nav-settings"]').click();
  check(
    "navigation remains on the left after switching pages",
    near((await nav.boundingBox()).x, current.x + 1),
  );
  check("header buttons do not drag the window", near((await box()).x, current.x));
  await panel.locator('[data-action="close-frontend"]').click();
  // The fixture's external Host button overlaps the launcher; use its keyboard action.
  await page.getByRole("button", { name: "打开预览", exact: true }).focus();
  await page.keyboard.press("Enter");
  resized = await box();
  check(
    "close and reopen retain bounds",
    near(current.x, resized.x) && near(current.width, resized.width),
  );
  await header.focus();
  await page.keyboard.press("Home");
  await header.evaluate((element) => element.blur());
  check("Home restores default bounds", near((await box()).width, 960));
  await page.setViewportSize({ width: 800, height: 600 });
  current = await box();
  check(
    "viewport shrink clamps window inside the screen",
    current.x >= 12 &&
      current.y >= 12 &&
      current.x + current.width <= 789 &&
      current.y + current.height <= 589,
  );
  await drag(header.locator("h1"), -1500, -1000);
  current = await box();
  check("drag cannot move the header offscreen", near(current.x, 12) && near(current.y, 12));
  await drag(panel.locator('[data-window-resize="se"]'), -1200, -1000);
  current = await box();
  check(
    "resize respects usable minimum size",
    near(current.width, 560) && near(current.height, 400),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  current = await box();
  const mobileNav = await nav.boundingBox();
  check(
    "mobile is full screen with bottom navigation",
    near(current.x, 0) &&
      near(current.y, 0) &&
      near(current.width, 320) &&
      near(current.height, 640) &&
      mobileNav.y > 560 &&
      mobileNav.width > 310,
  );
  check(
    "mobile hides all resize handles",
    await panel.locator('[data-window-resize="se"]').isHidden(),
  );
  await drag(header.locator("h1"), 20, 40);
  check("mobile title gestures do not move the surface", near((await box()).y, 0));
  await panel.locator('[data-action="nav-records"]').click();
  await panel.locator('[data-action="open-record"]').first().waitFor();
  check(
    "one navigation still opens the records page on mobile",
    await panel.locator('[data-action="record-sort"]').isVisible(),
  );
  check(
    "mobile content has no horizontal overflow",
    await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  current = await box();
  check(
    "returning to desktop restores the last desktop size",
    near(current.width, 560) && near(current.height, 400),
  );
  await header.focus();
  await page.keyboard.press("Home");
  const screenshots =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/desktop-window.png` });
  check("no page errors", errors.length === 0);
} finally {
  await browser.close();
}
