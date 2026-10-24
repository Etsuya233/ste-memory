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
    await p.screenshot({ path: path.join(__dirname, "screenshots", `preset-detail-${n}.png`) });
  };
  const openTable = async (name) => {
    await a("view-preset-table").filter({ hasText: name }).click();
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
    await a("open-table-preset").filter({ hasText: "剧情记忆" }).click();
    assert.equal(await a("view-preset-table").count(), 8, "preset detail lists tables");
    assert.equal(await a("edit-table-preset").count(), 1, "detail exposes edit in header");
    await shot("builtin-tables");
    await openTable("人际关系");
    assert.equal(
      await p.locator(".stm-field-list input[type=checkbox]").count(),
      0,
      "builtin has no fake switch",
    );
    assert.equal(
      await p.locator(".stm-table-settings .stm-settings-item-row--static").count(),
      3,
      "builtin table config is a static list",
    );
    await shot("builtin-fields");
    await a("view-preset-field").filter({ hasText: "关系定性" }).click();
    assert.equal(await p.locator('[data-stm-field="preset-field-detail"]').count(), 1);
    await a("edit-table-preset").click();
    assert.equal(
      await p.locator('[data-stm-field="field-name"]').inputValue(),
      "关系定性",
      "copy opens the same field",
    );
    await shot("copy-field");
    await p.locator('[data-stm-field="field-name"]').fill("关系定性已修改");
    await a("save-preset-field").click();
    await a("save-table-preset").click();
    assert.ok((await p.locator(".stm-header-title:visible").innerText()).includes("副本"));
    assert.equal(await a("view-preset-table").count(), 8, "save returns to preset detail");
    assert.equal(await a("edit-table-preset").count(), 1, "saved user preset remains read-only");

    await a("settings-more").click();
    for (const n of ["export-table-preset", "copy-preset", "overwrite-preset", "delete-preset"])
      assert.ok(await a(n).isVisible(), n + " reachable");
    await p.keyboard.press("Escape");
    await shot("user-tables");

    await openTable("人际关系");
    await a("edit-table-preset").click();
    const row = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改" });
    const toggle = row.locator("input");
    await row.locator("label").click();
    assert.equal(await toggle.isChecked(), false);
    assert.ok(await a("add-field").isVisible());
    assert.equal(await p.locator(".stm-table-settings .stm-settings-item-row").count(), 3);
    await shot("user-fields");
    await row.locator("button").click();
    await p.locator('[data-stm-field="field-name"]').fill("关系定性已修改2");
    await a("save-preset-field").click();
    assert.equal(await a("open-preset-table").count(), 0, "field completion stays in draft");
    await a("save-table-preset").click();
    assert.equal(await a("view-preset-table").count(), 8, "overall save stays on detail");

    await openTable("人际关系");
    const savedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改2" });
    await savedRow.waitFor();
    await a("edit-table-preset").click();
    assert.equal(await savedRow.locator("input").isChecked(), false);
    await savedRow.locator("button").click();
    assert.equal(
      await p.locator('[data-stm-field="field-name"]').inputValue(),
      "关系定性已修改2",
    );
    await p.locator('[data-stm-field="field-name"]').fill("丢弃字段改动");
    p.once("dialog", (d) => d.dismiss());
    await a("close-table-preset").click();
    assert.equal(await p.locator('[data-stm-field="field-name"]').inputValue(), "丢弃字段改动");
    p.once("dialog", (d) => d.accept());
    await a("close-table-preset").click();
    const editedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改2" });
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
    assert.ok(await a("edit-table-preset").isVisible(), "cancel returns to preset detail");
    await a("back-preset-list").click();
    await a("back-preset-list").click();
    await a("open-table-preset").filter({ hasText: "剧情记忆 副本" }).click();
    await openTable("人际关系");
    const reopenedRow = p.locator(".stm-field-row").filter({ hasText: "关系定性已修改2" });
    await a("edit-table-preset").click();
    assert.equal(await reopenedRow.locator("input").isChecked(), false, "cancel discards draft");
    assert.deepEqual(errors, []);
    console.log(
      "PASS preset read-only detail/copy edit; shared field/config sections; user preset detail-first; draft save/reopen; cancel protection.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
