const {
  chromium,
} = require("C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const action = (n) => p.locator(`[data-action="${n}"]:visible`);
  const shot = async (n) => {
    await p
      .locator(".stm-page-content")
      .first()
      .evaluate((e) => (e.scrollTop = 0));
    await p.screenshot({ path: path.join(__dirname, "screenshots", `field-list-${n}.png`) });
  };
  try {
    await p.goto("http://127.0.0.1:8799/?tab=settings&fixture=preset-fields");
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        "ste-memory.appearance.v1",
        JSON.stringify({ theme: "light", liquidGlass: true }),
      );
    });
    await p.reload();
    await p.locator('button[data-group="table-presets"]').click();
    await p.locator('[data-action="preview-table-preset"]').nth(1).click();
    const previewText = await p
      .locator('[data-stm-section="preset-structure-preview"]')
      .innerText();
    assert.ok(previewText.includes("人际关系"));
    assert.ok(previewText.includes("单引用"));
    assert.ok(previewText.includes("长文本"));
    assert.ok(!previewText.includes("single_reference"));
    await shot("preset-preview");
    await action("close-preset-structure-preview").click();
    await action("open-table-preset").filter({ hasText: "剧情记忆" }).click();
    await action("open-preset-table").filter({ hasText: "人际关系" }).click();
    await p.locator(".stm-field-row").first().waitFor();
    const presetRows = await p.locator(".stm-field-list").innerText();
    assert.equal(await p.locator(".stm-field-list").count(), 1);
    assert.equal(await p.locator(".stm-field-row input").count(), 4);
    assert.ok(presetRows.includes("单引用"));
    assert.ok(presetRows.includes("长文本"));
    assert.ok(!presetRows.includes("single_reference"));
    await shot("preset-relations");
    await p.goto("http://127.0.0.1:8799/?tab=tables&fixture=preset-fields");
    await action("expand-table").filter({ hasText: "人际关系" }).click();
    await action("edit-field").first().waitFor();
    assert.equal(await p.locator(".stm-field-list").innerText(), presetRows);
    await shot("table-relations");
    assert.deepEqual(errors, []);
    console.log(
      "PASS shared field/config sections, full structure preview, direct preset edit and equal real builtin structure; 390 light glass screenshots.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
