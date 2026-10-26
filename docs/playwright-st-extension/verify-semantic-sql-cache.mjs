/** Focused native semantic SQL/cache acceptance. Synthetic by default.
 * --real requires STE_EMBEDDING_API_DIR and an existing --budget-file with
 * {"limit":3,"posts":0}. The counter is persisted before each real POST.
 * ST_URL / STE_ST_INSTALL / CHROME / PLAYWRIGHT_MODULE_PATH select the host.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { switchTab, openSettingsGroup } from "./ui-navigation.mjs";

const { values } = parseArgs({
  options: {
    real: { type: "boolean" },
    "budget-file": { type: "string" },
    output: { type: "string" },
  },
});
const real = values.real === true;
const stUrl = process.env.ST_URL ?? "http://127.0.0.1:8000";
const install = process.env.STE_ST_INSTALL;
const chrome = process.env.CHROME;
assert(install && existsSync(path.join(install, "public", "script.js")), "STE_ST_INSTALL missing");
assert(chrome && existsSync(chrome), "CHROME missing");
const apiDirectory = process.env.STE_EMBEDDING_API_DIR;
assert(!real || apiDirectory, "Real mode requires STE_EMBEDDING_API_DIR");
assert(
  !real || (values["budget-file"] && existsSync(values["budget-file"])),
  "Real mode requires an existing persistent budget file",
);
const embedding = real
  ? {
      baseUrl: readFileSync(path.join(apiDirectory, "baseUrl.txt"), "utf8").trim(),
      model: readFileSync(path.join(apiDirectory, "model.txt"), "utf8").trim(),
      apiKey: readFileSync(path.join(apiDirectory, "apiKey.txt"), "utf8").trim(),
      maxInputChars: 4000,
      timeoutSeconds: 30,
    }
  : {
      baseUrl: "https://semantic-e2e.invalid/v1",
      model: "semantic-e2e",
      apiKey: "synthetic-only",
      dimensions: 3,
      maxInputChars: 4000,
      timeoutSeconds: 30,
    };
const endpoint = `${embedding.baseUrl.replace(/\/$/, "")}/embeddings`;
const runId = `STE-semantic-e2e-${Date.now()}`;
const output = values.output ?? path.join(tmpdir(), runId);
mkdirSync(output, { recursive: true });
const hashes = Object.fromEntries(
  ["index.js", "sqlite-worker.js"].map((name) => [
    name,
    createHash("sha256")
      .update(
        readFileSync(
          path.join(install, "public", "scripts", "extensions", "third-party", "ste-memory", name),
        ),
      )
      .digest("hex"),
  ]),
);
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright-core",
);
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-proxy-server"],
  env: {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
  },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const checks = [],
  errors = [],
  requests = [],
  characters = [],
  spaces = new Set(),
  mainRequests = [];
let originalCaptured = false,
  delay = 0,
  embeddingPosts = 0,
  realPosts = 0;
const safe = (error) => String(error).replaceAll(embedding.apiKey, "[redacted]");
page.on("pageerror", (error) => errors.push(safe(error.message)));
page.on("dialog", (dialog) => dialog.accept());
async function check(name, action) {
  try {
    const detail = await action();
    checks.push({ name, ok: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error: safe(error) });
    console.error(`FAIL ${name}: ${safe(error)}`);
    throw error;
  }
}
async function current() {
  return page.evaluate(() => window.__STE_MEMORY_RUNTIME__.macro.getRecentResults());
}
async function generate(text = "古桥事故", type = "normal") {
  await page.evaluate(
    ({ text, type }) => {
      document.querySelector("#send_textarea").value = type === "normal" ? text : "";
      window.__semanticGeneration = SillyTavern.getContext().generate(type);
      window.__semanticGeneration.catch(() => {});
    },
    { text, type },
  );
}
async function finish() {
  await page.evaluate(async () => await window.__semanticGeneration);
}
async function test(macro, text = "古桥事故") {
  return page.evaluate(
    ({ macro, text }) =>
      window.__STE_MEMORY_RUNTIME__.macro.testMacro({
        macro,
        scope: "chat",
        lastUserMessage: text,
      }),
    { macro, text },
  );
}
function execution(result) {
  const value = result.diagnostics.find((item) => item?.execution)?.execution;
  assert(value, "Execution diagnostics missing");
  return value;
}
function requireSuccess(result) {
  assert.equal(result.status, "success", safe(result.error ?? "Expected success"));
  return JSON.parse(result.text);
}
async function waitRequestAfter(count) {
  const until = Date.now() + 10000;
  while (embeddingPosts === count && Date.now() < until) await page.waitForTimeout(25);
  assert.equal(embeddingPosts, count + 1, "Expected exactly one new embedding request");
}

try {
  await page.route("**/api/backends/chat-completions/generate", async (route) => {
    mainRequests.push({
      at: Date.now(),
      hasOutput: JSON.stringify(route.request().postDataJSON()).includes("红色披风"),
    });
    await route.fulfill({
      json: {
        id: runId,
        object: "chat.completion",
        model: "e2e",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "验收响应。" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
  });
  await page.route(
    (url) => url.href === endpoint,
    async (route) => {
      const request = {
        number: embeddingPosts + 1,
        startedAt: Date.now(),
        responseAt: null,
        endedAt: null,
        status: null,
        real,
      };
      try {
        if (route.request().method() !== "POST") {
          await route.fulfill({
            status: 204,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "POST, OPTIONS",
              "access-control-allow-headers": "*",
            },
          });
          return;
        }
        embeddingPosts++;
        requests.push(request);
        if (real) {
          const budget = JSON.parse(readFileSync(values["budget-file"], "utf8"));
          assert.equal(budget.limit, 3, "Budget limit must remain three");
          assert(budget.posts < 3, "External embedding POST budget exhausted");
          budget.posts++;
          writeFileSync(values["budget-file"], JSON.stringify(budget, null, 2), "utf8");
          realPosts++;
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
          request.status = response.status();
          request.responseAt = Date.now();
          assert(response.ok(), `Embedding HTTP ${response.status()}`);
          if (delay) await page.waitForTimeout(delay);
          if (route.request().failure()) {
            await route.abort("aborted");
            return;
          }
          await route.fulfill({
            response,
            headers: { ...response.headers(), "access-control-allow-origin": "*" },
          });
        } else {
          const input = route.request().postDataJSON().input;
          const texts = Array.isArray(input) ? input : [input];
          request.responseAt = Date.now();
          request.status = 200;
          if (delay) await page.waitForTimeout(delay);
          if (route.request().failure()) {
            await route.abort("aborted");
            return;
          }
          await route.fulfill({
            json: {
              object: "list",
              model: embedding.model,
              data: texts.map((text, index) => ({
                object: "embedding",
                index,
                embedding: [1, String(text).includes("古桥") ? 1 : 0, 0.1],
              })),
            },
            headers: { "access-control-allow-origin": "*" },
          });
        }
      } catch (error) {
        const message = safe(error);
        errors.push(message);
        request.error = message;
        console.error("Embedding route error:", message);
        try {
          await route.abort("failed");
        } catch (abortError) {
          errors.push(safe(abortError));
        }
      } finally {
        request.endedAt = Date.now();
      }
    },
  );
  console.log(`Loading ST (${real ? "real budget <=3" : "synthetic, zero external requests"})`);
  await page.goto(stUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.__STE_MEMORY_RUNTIME__, null, { timeout: 60000 });
  await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0);
  await page.evaluate(async () => {
    const r = window.__STE_MEMORY_RUNTIME__,
      ctx = SillyTavern.getContext(),
      st = await import("/script.js"),
      { oai_settings } = await import("/scripts/openai.js");
    window.__semanticOriginal = {
      settings: structuredClone(r.settings.read()),
      mainApi: ctx.mainApi,
      onlineStatus: ctx.onlineStatus,
      oai: structuredClone(oai_settings),
      avatar: ctx.characters[ctx.characterId]?.avatar,
    };
    st.changeMainAPI("openai");
    Object.assign(oai_settings, {
      chat_completion_source: "custom",
      custom_url: "https://semantic-e2e.invalid/v1",
      custom_model: "e2e",
      stream_openai: false,
    });
    st.setOnlineStatus("e2e-ready");
    r.settingsService.save({
      ...r.settings.read(),
      enabled: true,
      macroName: "steSemantic",
      macroLimit: 10000,
      macros: [],
      autoFill: { ...r.settings.read().autoFill, enabled: false },
    });
    await r.macro.kick();
  });
  originalCaptured = true;
  const avatar = await page.evaluate(async (name) => {
    const ctx = SillyTavern.getContext(),
      form = new FormData();
    for (const [key, value] of Object.entries({
      ch_name: name,
      file_name: name,
      description: "内联语义验收 {{steSemantic::inline}}",
      first_mes: "验收开始。",
    }))
      form.set(key, value);
    const response = await fetch("/api/characters/create", {
      method: "POST",
      headers: ctx.getRequestHeaders({ omitContentType: true }),
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Create HTTP ${response.status}`);
    const avatar = await response.text();
    const list = await fetch("/api/characters/all", {
      method: "POST",
      headers: ctx.getRequestHeaders(),
      body: "{}",
    });
    const card = (await list.json()).find((item) => item.avatar === avatar);
    if (!card) throw new Error("Created character missing");
    card.chat ||= `${name} - dedicated`;
    ctx.characters.push(card);
    return avatar;
  }, runId);
  characters.push(avatar);
  const space = await page.evaluate(async (avatar) => {
    const ctx = SillyTavern.getContext(),
      r = window.__STE_MEMORY_RUNTIME__,
      index = ctx.characters.findIndex((card) => card.avatar === avatar);
    await ctx.selectCharacterById(index);
    await r.manager.syncToCurrentChat();
    const state = r.manager.getStatus();
    if (state?.kind !== "active" || !state.space.name.startsWith(ctx.characters[index].name))
      throw new Error("Dedicated space not active");
    return state.space.id;
  }, avatar);
  spaces.add(space);
  const fixture = await page.evaluate(
    async ({ space, embedding }) => {
      const r = window.__STE_MEMORY_RUNTIME__;
      await r.settingsService.setEmbeddingConnection(embedding);
      const table = await r.tables.create(space, {
        key: "events",
        name: "验收事件",
        description: "",
        prompt: "",
        position: 100,
      });
      const summary = await r.fields.create(space, table.id, {
        key: "summary",
        name: "摘要",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
      });
      const state = await r.fields.create(space, table.id, {
        key: "state",
        name: "状态",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 1,
      });
      await r.fields.setDisplayStrategy(space, table.id, { type: "field", fieldId: summary.id });
      await r.tables.update(space, table.id, {
        vectorIndex: {
          enabled: true,
          source: "custom",
          updateMode: "manual",
          groups: [
            {
              id: crypto.randomUUID(),
              key: "event_memory",
              name: "事件组",
              fieldIds: [summary.id],
            },
          ],
        },
      });
      const record = await r.records.create(space, table.id, {
        payload: { [summary.id]: "古桥事故发现红色披风", [state.id]: "未核实" },
      });
      const base = { enabled: true, output: { format: "json", maxChars: 10000 } };
      const select =
        'SELECT e.summary AS "摘要", e.state AS "状态", s.score AS "$similarity" FROM events e JOIN ';
      const tail = ' s ON s.record_id=e."$record_id" ORDER BY s.score DESC LIMIT 5';
      const macros = [
        {
          ...base,
          id: crypto.randomUUID(),
          name: "query",
          expression: {
            language: "query",
            query: {
              table: "events",
              fields: ["summary", "state", "$similarity"],
              semantic: { groups: ["event_memory"], query: { context: "last_user_message" } },
              orderBy: { field: "$similarity", direction: "desc" },
              limit: 5,
            },
          },
        },
        {
          ...base,
          id: crypto.randomUUID(),
          name: "inline",
          expression: {
            language: "sql",
            sql:
              select +
              "semantic_scores('events', json_array('event_memory'), :last_user_message)" +
              tail,
          },
        },
        {
          ...base,
          id: crypto.randomUUID(),
          name: "legacy",
          expression: {
            language: "sql",
            sources: [
              {
                name: "related",
                table: "events",
                groups: ["event_memory"],
                query: { context: "last_user_message" },
              },
            ],
            sql: select + "related" + tail,
          },
        },
      ];
      await r.settingsService.setChatScopeMacros(macros);
      const disabled = r.cleaning.readChatScopeMacros();
      if (!disabled.every((macro) => !macro.enabled))
        throw new Error("New semantic definitions must default disabled");
      await r.settingsService.setChatScopeMacros(
        disabled.map((macro) => ({ ...macro, enabled: true })),
      );
      await r.vector.submit({ memorySpaceId: space, tableId: table.id }, { source: "manual" });
      return {
        tableId: table.id,
        stateField: state.id,
        recordId: record.id,
        macros: r.cleaning.readChatScopeMacros(),
      };
    },
    { space, embedding },
  );
  await check("one record index / prepare-only saves issue no query request", async () => {
    const until = Date.now() + 60000;
    let tasks;
    do {
      tasks = await page.evaluate(
        ({ space, table }) =>
          window.__STE_MEMORY_RUNTIME__.vector.listTasks({ memorySpaceId: space, tableId: table }),
        { space, table: fixture.tableId },
      );
      if (tasks.items.length === 1 && tasks.items[0].status === "succeeded") break;
      assert(!tasks.items.some((task) => task.status === "failed"), "Index task failed");
      await page.waitForTimeout(50);
    } while (Date.now() < until);
    assert.equal(tasks.items[0]?.status, "succeeded");
    assert.equal(embeddingPosts, 1);
    return { embeddingPosts };
  });
  // The fixture writes through services; refresh the panel's settings snapshot through its UI.
  await page.locator("#top-settings-holder .stm-toolbar-button").click();
  await switchTab(page, "settings");
  const settingsBack = page.locator('#stm-panel [data-action="settings-back"]');
  if (await settingsBack.isVisible()) await settingsBack.click();
  await page.getByRole("checkbox", { name: "插件总开关", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "插件总开关", exact: true }).check();
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__.manager.getStatus()?.kind === "active",
  );
  await page.locator("#top-settings-holder .stm-toolbar-button").click();
  await check("cold generation shares one query across Query / inline / legacy SQL", async () => {
    const before = embeddingPosts;
    delay = 600;
    await generate(" 古桥事故 ");
    await finish();
    delay = 0;
    assert.equal(embeddingPosts - before, 1);
    const rows = await current();
    const q = rows.find((row) => row.name === "query"),
      sql = rows.find((row) => row.name === "inline"),
      legacy = rows.find((row) => row.name === "legacy");
    assert.deepEqual(requireSuccess(q), requireSuccess(sql));
    assert.deepEqual(requireSuccess(q), requireSuccess(legacy));
    assert(mainRequests.at(-1).hasOutput);
    return rows
      .filter((row) => ["query", "inline", "legacy"].includes(row.name))
      .map((row) => ({ name: row.name, execution: execution(row) }));
  });
  await check(
    "regenerate uses L2 while record changes are queried from a fresh snapshot",
    async () => {
      const before = embeddingPosts;
      await page.evaluate(
        async ({ space, fixture }) => {
          const r = window.__STE_MEMORY_RUNTIME__,
            record = await r.records.find(space, fixture.tableId, fixture.recordId);
          await r.records.update(space, fixture.tableId, record.id, {
            expectedRevisionId: record.revisionId,
            patch: { [fixture.stateField]: "已核实" },
            revisionSource: "user",
          });
        },
        { space, fixture },
      );
      await generate("", "regenerate");
      await finish();
      assert.equal(embeddingPosts, before);
      const row = (await current()).find((row) => row.name === "inline");
      assert.equal(requireSuccess(row)[0]["状态"], "已核实");
      assert(execution(row).queryVectors.sharedHits >= 1);
      return execution(row);
    },
  );
  await check(
    "explicit inline test reuses L2 and leaves actual-generation results intact",
    async () => {
      const before = embeddingPosts,
        actual = await current();
      const result = await test(fixture.macros.find((macro) => macro.name === "inline"));
      requireSuccess(result);
      assert.equal(embeddingPosts, before);
      assert(execution(result).queryVectors.sharedHits >= 1);
      assert.deepEqual(await current(), actual);
      return execution(result);
    },
  );
  await check(
    "native repeated cursors / json_array / interrupted UNION return complete results",
    async () => {
      const before = embeddingPosts;
      const base = fixture.macros.find((macro) => macro.name === "inline");
      const result = await test({
        ...base,
        expression: {
          language: "sql",
          sql: "SELECT 'prefix' AS value UNION ALL SELECT e.summary AS value FROM events e JOIN semantic_scores('events', '[\"event_memory\"]', :last_user_message) s ON s.record_id=e.\"$record_id\" JOIN semantic_scores('events', json_array('event_memory'), :last_user_message) repeated ON repeated.record_id=e.\"$record_id\"",
        },
      });
      const rows = requireSuccess(result);
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((row) => row.value === "prefix").length, 1);
      assert.equal(embeddingPosts, before);
      assert.equal(execution(result).preparedSources, 1);
      return execution(result);
    },
  );
  await check(
    "legacy UI is read-only; failed explicit conversion preserves the stored definition",
    async () => {
      await page.locator("#top-settings-holder .stm-toolbar-button").click();
      await switchTab(page, "settings");
      await openSettingsGroup(page, "macro");
      await page.locator('[data-macro-scope="chat"]').click();
      const item = page.locator(`[data-macro-id="${fixture.macros[2].id}"]`);
      await item.getByRole("button", { name: "编辑 / 改名" }).click();
      assert(
        await page.getByLabel("原 sources JSON（只读）").evaluate((element) => element.readOnly),
      );
      assert(await page.getByLabel("原 SQL（只读）").evaluate((element) => element.readOnly));
      await page.getByLabel("宏名", { exact: true }).fill("legacy_edited");
      await page.getByRole("button", { name: "保存宏", exact: true }).click();
      await page.waitForFunction(
        (id) =>
          window.__STE_MEMORY_RUNTIME__.cleaning
            .readChatScopeMacros()
            .some((macro) => macro.id === id && macro.name === "legacy_edited"),
        fixture.macros[2].id,
      );
      await page
        .locator(`[data-macro-id="${fixture.macros[2].id}"]`)
        .getByRole("button", { name: "编辑 / 改名" })
        .click();
      const originalSql = await page.getByLabel("原 SQL（只读）").inputValue();
      await page.getByRole("button", { name: "转为内联 SQL 草稿" }).click();
      assert.equal(await page.getByLabel("SQL 正文", { exact: true }).inputValue(), originalSql);
      const before = embeddingPosts;
      await page.getByRole("button", { name: "保存宏", exact: true }).click();
      await page
        .locator('[data-expression-macro-editor] [role="alert"]')
        .waitFor({ state: "visible" });
      const stored = await page.evaluate(
        (id) =>
          window.__STE_MEMORY_RUNTIME__.cleaning
            .readChatScopeMacros()
            .find((macro) => macro.id === id),
        fixture.macros[2].id,
      );
      assert(stored.expression.sources?.length);
      assert.equal(embeddingPosts, before);
      await page.getByLabel("SQL 正文", { exact: true }).fill(fixture.macros[1].expression.sql);
      await page.getByRole("button", { name: "保存宏", exact: true }).click();
      await page.waitForFunction((id) => {
        const macro = window.__STE_MEMORY_RUNTIME__.cleaning
          .readChatScopeMacros()
          .find((macro) => macro.id === id);
        return (
          macro?.expression.language === "sql" &&
          !macro.expression.sources &&
          macro.expression.usesSemantic === true
        );
      }, fixture.macros[2].id);
      await page.screenshot({ path: path.join(output, "inline-macro-ui.png"), fullPage: true });
      await page.locator("#top-settings-holder .stm-toolbar-button").click();
      assert.equal(embeddingPosts, before);
    },
  );
  await check(
    "preset import compiles untrusted classification and saves normalized inline macros",
    async () => {
      const before = embeddingPosts;
      const name = `${runId}-preset`;
      const field = {
        key: "summary",
        name: "摘要",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        options: [],
        referenceTableKey: null,
        maxChars: null,
        valuePattern: null,
        valuePatternMessage: null,
      };
      const preset = {
        name,
        description: "内联分类验收",
        prompt: "",
        tables: [
          {
            key: "events",
            name: "事件",
            description: "",
            prompt: "",
            enabled: true,
            displayStrategy: { type: "field", fieldKey: "summary" },
            vectorIndex: {
              enabled: true,
              updateMode: "manual",
              groups: [{ key: "event_memory", name: "事件组", fieldKeys: ["summary"] }],
            },
            fields: [field],
          },
        ],
        macros: [
          {
            id: "untrusted-plain",
            name: "plain_import",
            enabled: true,
            expression: { language: "sql", sql: "SELECT summary FROM events", usesSemantic: true },
            output: { format: "json", maxChars: 10000 },
          },
          {
            id: "untrusted-semantic",
            name: "semantic_import",
            enabled: true,
            expression: {
              language: "sql",
              sql: "SELECT * FROM semantic_scores('events', json_array('event_memory'), :last_user_message)",
              usesSemantic: false,
            },
            output: { format: "json", maxChars: 10000 },
          },
        ],
      };
      await page.locator("#top-settings-holder .stm-toolbar-button").click();
      await switchTab(page, "settings");
      await openSettingsGroup(page, "table-presets");
      await page.locator('[data-stm-field="table-preset-import-file"]').setInputFiles({
        name: "semantic-preset.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            format: "ste-memory-table-preset",
            version: 3,
            exportedAt: new Date().toISOString(),
            preset,
          }),
        ),
      });
      await page.waitForFunction(
        (name) =>
          window.__STE_MEMORY_RUNTIME__.settings
            .read()
            .tablePresets.userPresets.some((preset) => preset.name === name),
        name,
      );
      let saved = await page.evaluate(
        (name) =>
          window.__STE_MEMORY_RUNTIME__.settings
            .read()
            .tablePresets.userPresets.find((preset) => preset.name === name),
        name,
      );
      assert.equal(saved.macros[0].expression.usesSemantic, false);
      assert.equal(saved.macros[0].enabled, true);
      assert.equal(saved.macros[1].expression.usesSemantic, true);
      assert.equal(saved.macros[1].enabled, false);
      await page.getByText("预设对话宏", { exact: true }).click();
      await page.getByRole("button", { name: "新增预设宏", exact: true }).click();
      await page.getByLabel("宏名", { exact: true }).fill("inline_new");
      await page.getByLabel("表达式语言", { exact: true }).selectOption("sql");
      await page
        .getByLabel("SQL 正文", { exact: true })
        .fill(
          "SELECT * FROM semantic_scores('events', json_array('event_memory'), :last_user_message)",
        );
      await page.getByRole("button", { name: "保存宏", exact: true }).click();
      await page.waitForFunction(
        (name) =>
          window.__STE_MEMORY_RUNTIME__.settings
            .read()
            .tablePresets.userPresets.find((preset) => preset.name === name)
            ?.macros.some((macro) => macro.name === "inline_new"),
        name,
      );
      saved = await page.evaluate(
        (name) =>
          window.__STE_MEMORY_RUNTIME__.settings
            .read()
            .tablePresets.userPresets.find((preset) => preset.name === name),
        name,
      );
      const added = saved.macros.find((macro) => macro.name === "inline_new");
      assert.equal(added.expression.usesSemantic, true);
      assert.equal(added.enabled, false);
      assert.equal(embeddingPosts, before);
      await page.locator("#top-settings-holder .stm-toolbar-button").click();
      return {
        importedPlainEnabled: true,
        importedSemanticEnabled: false,
        newSemanticEnabled: false,
        prepareOnlyPosts: embeddingPosts - before,
      };
    },
  );
  await check(
    "new-text cancellation ignores late response; cached successful text still works",
    async () => {
      const before = embeddingPosts;
      delay = 1800;
      await generate("古桥事故_取消缓存键");
      await waitRequestAfter(before);
      await page.evaluate(() => SillyTavern.getContext().stopGeneration());
      await finish();
      await page.waitForTimeout(2000);
      delay = 0;
      assert(
        (await current())
          .filter((row) => row.name === "inline")
          .every((row) => row.status === "cancelled"),
      );
      const cachedBefore = embeddingPosts;
      await generate("古桥事故");
      await finish();
      requireSuccess((await current()).find((row) => row.name === "inline"));
      assert.equal(embeddingPosts, cachedBefore);
      return {
        cancelPost: embeddingPosts - before,
        cachedRestartPosts: embeddingPosts - cachedBefore,
      };
    },
  );
  if (!real) {
    await check("cancelled query text never enters L2", async () => {
      const before = embeddingPosts;
      const result = await test(fixture.macros[1], "古桥事故_取消缓存键");
      requireSuccess(result);
      assert.equal(embeddingPosts - before, 1);
      return execution(result);
    });
    await check("credential revision isolates L2 while index profile remains usable", async () => {
      const before = embeddingPosts;
      await page.evaluate(
        async (connection) =>
          window.__STE_MEMORY_RUNTIME__.settingsService.setEmbeddingConnection(connection),
        { ...embedding, apiKey: "synthetic-new-revision" },
      );
      const result = await test(fixture.macros[1]);
      requireSuccess(result);
      assert.equal(embeddingPosts - before, 1);
      assert.equal(execution(result).queryVectors.sharedHits, 0);
      return execution(result);
    });
  }
  assert.equal(errors.length, 0, "Unexpected page / route errors");
} catch (error) {
  if (!checks.some((check) => !check.ok))
    checks.push({ name: "setup", ok: false, error: safe(error) });
  console.error("Acceptance stopped:", safe(error));
  try {
    const state = await page.evaluate(() => {
      const r = window.__STE_MEMORY_RUNTIME__,
        ctx = SillyTavern.getContext(),
        settings = r.settings.read();
      return {
        recent: r.macro.getRecentResults(),
        status: r.manager.getStatus()?.kind,
        macros: r.cleaning.readChatScopeMacros(),
        enabled: settings.enabled,
        macroName: settings.macroName,
        onlineStatus: ctx.onlineStatus,
        mainApi: ctx.mainApi,
        chatRoles: ctx.chat.map((row) => ({ user: row.is_user, system: row.is_system })),
        lastUser: ctx.chat.filter((row) => row.is_user).at(-1)?.mes,
      };
    });
    writeFileSync(
      path.join(output, "failure-state.json"),
      safe(JSON.stringify(state, null, 2)),
      "utf8",
    );
  } catch (stateError) {
    errors.push(safe(stateError));
  }
} finally {
  try {
    if (originalCaptured)
      await page.evaluate(
        async ({ characters, spaces }) => {
          const r = window.__STE_MEMORY_RUNTIME__,
            ctx = SillyTavern.getContext(),
            st = await import("/script.js"),
            { oai_settings } = await import("/scripts/openai.js");
          ctx.stopGeneration();
          r.macro.cancel("验收清理");
          for (const id of spaces) {
            await r.vector.purge({ memorySpaceId: id });
            await r.spaces.delete(id);
          }
          const original = window.__semanticOriginal;
          r.settingsService.save(original.settings);
          await r.macro.kick();
          Object.assign(oai_settings, original.oai);
          st.changeMainAPI(original.mainApi);
          st.setOnlineStatus(original.onlineStatus);
          if (original.avatar) {
            const index = ctx.characters.findIndex((card) => card.avatar === original.avatar);
            if (index >= 0) await ctx.selectCharacterById(index);
          }
          for (const avatar of characters) {
            const response = await fetch("/api/characters/delete", {
              method: "POST",
              headers: ctx.getRequestHeaders(),
              body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
            });
            if (!response.ok) throw new Error(`Cleanup HTTP ${response.status}`);
          }
          ctx.saveSettingsDebounced();
          return true;
        },
        { characters, spaces: [...spaces] },
      );
    await page.waitForTimeout(2500);
    checks.push({ name: "restore settings and remove dedicated test data", ok: true });
  } catch (error) {
    checks.push({ name: "cleanup", ok: false, error: safe(error) });
  }
  await page.unrouteAll({ behavior: "wait" });
  await browser.close();
  const budget = real ? JSON.parse(readFileSync(values["budget-file"], "utf8")) : null;
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        runId,
        mode: real ? "real" : "synthetic",
        hashes,
        checks,
        errors,
        embeddingPosts,
        realPosts,
        requests,
        budget,
      },
      null,
      2,
    ),
    "utf8",
  );
}
console.log(
  `${checks.filter((check) => check.ok).length}/${checks.length} passed; external POSTs=${realPosts}; ${path.join(output, "report.json")}`,
);
process.exitCode = checks.every((check) => check.ok) && errors.length === 0 ? 0 : 1;
