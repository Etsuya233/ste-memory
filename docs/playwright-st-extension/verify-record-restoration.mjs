import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
try {
  for (const width of [320, 390, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
    const snapshot = () => page.evaluate(() => window.frontendPreview.snapshot());
    const editor = () => page.evaluate(() => window.frontendPreview.workspace.getSnapshot().editor);
    async function history() {
      const trigger = page.getByRole("button", { name: /修订历史/ });
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      await action("restore-revision").waitFor();
    }
    await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
    await action("open-record").click();
    await action("edit-record").click();
    const name = page.getByRole("textbox", { name: "名称", exact: true });
    const original = await name.inputValue();
    await name.fill("保存后的新版本");
    await action("save-record").click();
    await action("edit-record").waitFor();
    const committed = await snapshot();
    await history();
    await action("restore-revision").click();
    await name.waitFor();
    assert.equal(await name.inputValue(), original);
    assert.deepEqual(await snapshot(), committed, "restoring does not write data");
    assert.equal((await editor()).dirty, true);
    await history();
    await action("restore-revision").click();
    await page.getByRole("button", { name: "保留编辑", exact: true }).click();
    assert.equal(await name.inputValue(), original, "cancelling confirmation preserves draft");
    await name.fill("尚未保存的修改");
    await history();
    await action("restore-revision").click();
    await page.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
    assert.equal(await name.inputValue(), original, "confirmed restoration replaces draft");
    assert.deepEqual(await snapshot(), committed);
    await action("cancel-edit").click();
    await page.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
    await action("edit-record").waitFor();
    assert.deepEqual(await snapshot(), committed, "discard leaves committed record unchanged");
    await history();
    await action("restore-revision").click();
    await name.waitFor();
    const directory = new URL("../../node_modules/.cache/frontend-preview/screenshots/", import.meta.url);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`record-restoration-${width}.png`, directory)) });
    assert.ok(await page.getByRole("form", { name: "记录编辑" }).evaluate((form) => form.scrollWidth <= form.clientWidth), "editor fits viewport");
    await action("save-record").click();
    await action("edit-record").waitFor();
    const state = await page.evaluate(() => window.frontendPreview.workspace.getSnapshot());
    assert.equal(state.detail.payload.name, original);
    assert.equal(state.history.length, 2, "saving restoration preserves history and archives current version");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS revision restoration: draft only, overwrite confirmation, discard, manual save, retained history at 320/390/1100px");
} finally {
  await browser.close();
}
