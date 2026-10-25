const {
  chromium,
} = require("C:/Users/Etsuya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const a = (n) => p.locator(`[data-action="${n}"]:visible`);
  const shot = async (n) => {
    await p
      .locator(".stm-page-content")
      .first()
      .evaluate((e) => (e.scrollTop = 0));
    await p.mouse.move(0, 0);
    await p.screenshot({ path: path.join(__dirname, "screenshots", `preset-direct-${n}.png`) });
  };
  const openTable = async (name) => {
    await a("open-preset-table").filter({ hasText: name }).click();
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

    await p.locator('[data-action="preview-table-preset"]').first().click();
    assert.equal(
      await p.locator('[data-stm-section="preset-structure-preview"]').count(),
      1,
      "list exposes full structure preview",
    );
    await shot("preview");
    await a("close-preset-structure-preview").click();
    assert.equal(await p.locator('[data-stm-section="preset-structure-preview"]').count(), 0);

    await a("open-table-preset").filter({ hasText: "剧情记忆" }).click();
    assert.equal(await a("open-preset-table").count(), 8, "builtin opens editable copy");
    assert.equal(await p.locator('[data-stm-field="preset-field-detail"]').count(), 0);
    assert.ok((await p.locator(".stm-header-title:visible").innerText()).includes("编辑预设"));
    await shot("copy-overview");
    await a("settings-more").click();
    for (const n of ["export-table-preset", "copy-preset"])
      assert.ok(await a(n).isVisible(), n + " reachable");
    await p.keyboard.press("Escape");

    await openTable("人际关系");
    assert.equal(await p.locator(".stm-field-row input").count(), 4);
    assert.ok(await a("add-field").isVisible());
    assert.equal(await p.locator(".stm-table-settings .stm-settings-item-row").count(), 3);
    const row = p.locator(".stm-field-row").filter({ hasText: "关系定性" });
    await row.locator("label").click();
    assert.equal(await row.locator("input").isChecked(), false);
    await row.locator("button").click();
    await p.locator('[data-stm-field="field-name"]').fill("关系定性已修改");
    await a("save-preset-field").click();
    assert.equal(await a("open-preset-table").count(), 0, "field completion stays in draft");
    await shot("copy-fields");
    await a("save-table-preset").click();
    assert.equal(await a("open-table-preset").count(), 4, "save returns to preset list");

    await a("open-table-preset").filter({ hasText: "剧情记忆 副本" }).click();
    assert.equal(await a("open-preset-table").count(), 8, "user preset enters editor directly");
    await openTable("人际关系");
    const savedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改" });
    assert.equal(await savedRow.locator("input").isChecked(), false);
    assert.ok(await a("toggle-preset-field-edit").isVisible());
    await a("toggle-preset-field-edit").click();
    assert.equal(await a("delete-preset-field").count(), 4, "field list offers inline delete");
    await shot("user-fields");
    await a("toggle-preset-field-edit").click();

    await savedRow.locator("button").click();
    await p.locator('[data-stm-field="field-name"]').fill("丢弃字段改动");
    p.once("dialog", (d) => d.dismiss());
    await a("close-table-preset").click();
    assert.equal(await p.locator('[data-stm-field="field-name"]').inputValue(), "丢弃字段改动");
    p.once("dialog", (d) => d.accept());
    await a("close-table-preset").click();
    const editedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改" });
    await editedRow.locator("label").click();
    await a("close-table-preset").click();
    p.once("dialog", (d) => d.dismiss());
    await a("close-table-preset").click();
    assert.equal(
      await a("open-preset-table").count(),
      8,
      "dismiss keeps the overall editor",
    );
    p.once("dialog", (d) => d.accept());
    await a("close-table-preset").click();
    assert.equal(await a("open-table-preset").count(), 4, "cancel returns to preset list");

    await a("open-table-preset").filter({ hasText: "剧情记忆 副本" }).click();
    await openTable("人际关系");
    const reopenedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改" });
    assert.ok(await reopenedRow.isVisible());
    assert.equal(await reopenedRow.locator("input").isChecked(), false, "cancel discards draft");
    assert.deepEqual(errors, []);
    console.log(
      "PASS preset list direct edit, builtin copy, structure preview modal, shared field/config sections, draft save/reopen, cancel protection.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
