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
    await action("open-table-preset").filter({ hasText: "剧情记忆" }).click();
    await action("view-preset-table").filter({ hasText: "人际关系" }).click();
    await p.locator(".stm-field-row").first().waitFor();
    const presetRows = await p.locator(".stm-field-list").innerText();
    assert.equal(await p.locator(".stm-field-list").count(), 1);
    assert.equal(await p.locator(".stm-field-list details").count(), 0);
    assert.equal(await p.locator(".stm-field-row input").count(), 0);
    assert.ok(presetRows.includes("单引用"));
    assert.ok(presetRows.includes("长文本"));
    assert.ok(!presetRows.includes("single_reference"));
    await shot("preset-relations");
    await action("view-preset-field").first().click();
    assert.equal(await p.locator('[data-stm-field="preset-field-detail"]').count(), 1);
    assert.match(
      await p.locator('[data-stm-field="preset-field-detail"]').innerText(),
      /Key.*类型.*单引用/s,
    );
    await shot("preset-field-detail");
    await action("back-preset-list").click();
    assert.equal(await action("view-preset-field").count(), 4);
    await action("edit-table-preset").click();
    await action("edit-field").first().waitFor();
    assert.equal(await p.locator(".stm-field-list").innerText(), presetRows);
    await shot("preset-edit-relations");
    await p.goto("http://127.0.0.1:8799/?tab=tables&fixture=preset-fields");
    await action("expand-table").filter({ hasText: "人际关系" }).click();
    await action("edit-field").first().waitFor();
    assert.equal(await p.locator(".stm-field-list").innerText(), presetRows);
    await shot("table-relations");
    assert.deepEqual(errors, []);
    console.log(
      "PASS shared field lists, readonly detail/back, contextual editor and equal real builtin structure; 390 light glass screenshots.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
