import { createHash } from "node:crypto";
/** Real ST acceptance. Creates two disposable characters/chats and restores settings.
 * ST_URL, STE_ST_INSTALL, CHROME, STE_EMBEDDING_API_DIR are required environment inputs.
 * The API directory contains baseUrl.txt, model.txt, apiKey.txt. Secrets stay in memory.
 * Optional: PLAYWRIGHT_MODULE_PATH, STE_E2E_OUTPUT, STE_E2E_HEADED=1.
 * Run only after deploying the build under test to this ST installation.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { switchTab, openSettingsGroup } from "./ui-navigation.mjs";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    install: { type: "string" },
    chrome: { type: "string" },
    "api-dir": { type: "string" },
    output: { type: "string" },
    headed: { type: "boolean" },
    "stop-probe": { type: "boolean" },
    synthetic: { type: "boolean" },
    "tc-probe": { type: "boolean" },
  },
});
const stopProbe = values["stop-probe"] === true;
const synthetic = values.synthetic === true;
const tcProbe = values["tc-probe"] === true;
const stUrl = values.url ?? process.env.ST_URL ?? "http://127.0.0.1:8000";
const installation = values.install ?? process.env.STE_ST_INSTALL;
const chrome = values.chrome ?? process.env.CHROME;
const apiDirectory = values["api-dir"] ?? process.env.STE_EMBEDDING_API_DIR;
assert(
  installation && existsSync(path.join(installation, "public", "script.js")),
  "STE_ST_INSTALL must identify the running ST installation",
);
assert(chrome && existsSync(chrome), "CHROME must identify a browser executable");
assert(apiDirectory, "STE_EMBEDDING_API_DIR must identify the embedding credentials directory");
const embedding = {
  baseUrl: readFileSync(path.join(apiDirectory, "baseUrl.txt"), "utf8").trim(),
  model: readFileSync(path.join(apiDirectory, "model.txt"), "utf8").trim(),
  apiKey: readFileSync(path.join(apiDirectory, "apiKey.txt"), "utf8").trim(),
  maxInputChars: 4000,
  timeoutSeconds: 30,
};
const artifactHashes = Object.fromEntries(
  ["index.js", "sqlite-worker.js"].map((name) => [
    name,
    createHash("sha256")
      .update(
        readFileSync(
          path.join(
            installation,
            "public",
            "scripts",
            "extensions",
            "third-party",
            "ste-memory",
            name,
          ),
        ),
      )
      .digest("hex"),
  ]),
);
const runId = `STE-expression-e2e-${Date.now()}`;
const output = values.output ?? process.env.STE_E2E_OUTPUT ?? path.join(tmpdir(), runId);
mkdirSync(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright-core",
);
const browser = await chromium.launch({
  executablePath: chrome,
  headless: !(values.headed ?? process.env.STE_E2E_HEADED === "1"),
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
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(safeError(error.message)));
page.on("dialog", (dialog) => dialog.accept());
console.log("Browser ready; initializing ST acceptance");
const checks = [];
const characters = [];
const spaces = new Set();
const generated = [];
const embeddingTimings = [];
const diagnostics = {};
let embeddingCalls = 0;
let realEmbeddingCalls = 0;
let embeddingDelay = 0;
let embeddingStarted = 0;
let embeddingFinished = 0;
let settingsCaptured = false;
let worldCreated = false;
const worldBook = `${runId}-world`;
function safeError(error) {
  return String(error).replaceAll(embedding.apiKey, "[redacted]");
}
async function check(name, work) {
  if (stopProbe && !name.includes("建立索引") && name !== "ST 停止取消未完成计算，迟到结果不发布")
    return;
  if (
    tcProbe &&
    !name.includes("建立索引") &&
    ![
      "真实正常生成等待宏、同批一次 embedding、提示词命中",
      "真实 continue 重新求值",
      "独立 dry run 与 quiet 不请求查询向量",
      "Text Completion 真实提示词构建使用本批宏与世界书",
    ].includes(name)
  )
    return;
  try {
    const detail = await work();
    checks.push({ name, ok: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error: safeError(error) });
    console.error(`FAIL ${name}: ${safeError(error)}`);
    throw error;
  }
}
async function recent() {
  return page.evaluate(() => window.__STE_MEMORY_RUNTIME__.macro.getRecentResults());
}
async function waitForEvaluation() {
  await page.waitForFunction(
    () =>
      window.__STE_MEMORY_RUNTIME__.macro
        .getRecentResults()
        .some(
          (result) => result.name === "semantic" && !["running", "not-run"].includes(result.status),
        ),
    null,
    { timeout: 20000 },
  );
}
async function generate(type = "normal", text = "古桥事故的线索") {
  await page.evaluate(
    ({ type, text }) => {
      document.querySelector("#send_textarea").value = type === "normal" ? text : "";
      window.__expressionGenerationSettled = false;
      window.__expressionGeneration = SillyTavern.getContext().generate(type);
      window.__expressionGeneration.then(
        () => {
          window.__expressionGenerationSettled = true;
        },
        () => {
          window.__expressionGenerationSettled = true;
        },
      );
      window.__expressionGenerationError = null;
      window.__expressionGeneration.catch((error) => {
        window.__expressionGenerationError = String(error);
      });
    },
    { type, text },
  );
}
async function finishGeneration() {
  await page.evaluate(async () => {
    await window.__expressionGeneration;
  });
  const error = await page.evaluate(() => window.__expressionGenerationError);
  assert.equal(error, null);
}
async function createCharacter(suffix) {
  console.log(`Creating dedicated character ${suffix}`);
  const avatar = await page.evaluate(
    async ({ name, description }) => {
      const ctx = SillyTavern.getContext();
      const form = new FormData();
      for (const [key, value] of Object.entries({
        ch_name: name,
        file_name: name,
        description,
        first_mes: "验收对话开始。",
        personality: "只用于自动验收。",
        scenario: "表达式宏验收",
      }))
        form.set(key, value);
      const headers = ctx.getRequestHeaders({ omitContentType: true });
      const response = await fetch("/api/characters/create", {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Character create failed: ${response.status}`);
      const avatar = await response.text();
      const listResponse = await fetch("/api/characters/all", {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      if (!listResponse.ok) throw new Error(`Character list failed: ${listResponse.status}`);
      const card = (await listResponse.json()).find((item) => item.avatar === avatar);
      if (!card) throw new Error("Created character absent from server list");
      card.chat ||= `${name} - dedicated`;
      ctx.characters.push(card);
      return avatar;
    },
    {
      name: `${runId}-${suffix}`,
      description:
        "仅使用测试数据。表达式结果：{{steExpression::semantic}}；SQL结果：{{steExpression::semantic_sql}}",
    },
  );
  characters.push(avatar);
  return avatar;
}
async function selectCharacter(avatar) {
  await page.evaluate(async (avatar) => {
    const ctx = SillyTavern.getContext();
    const index = ctx.characters.findIndex((character) => character.avatar === avatar);
    if (index < 0) throw new Error("Dedicated test character not found");
    await ctx.selectCharacterById(index);
    await window.__STE_MEMORY_RUNTIME__.manager.syncToCurrentChat();
    const status = window.__STE_MEMORY_RUNTIME__.manager.getStatus();
    if (status?.kind !== "active" || !status.space.name.startsWith(ctx.characters[index].name))
      throw new Error("Selected test character has no dedicated active space");
  }, avatar);
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__.manager.getStatus()?.kind === "active",
    null,
    { timeout: 30000 },
  );
  const id = await page.evaluate(() => window.__STE_MEMORY_RUNTIME__.manager.getStatus().space.id);
  spaces.add(id);
  return id;
}

try {
  await page.route("**/api/backends/chat-completions/generate", async (route) => {
    generated.push({ at: Date.now(), body: route.request().postDataJSON(), api: "chat" });
    await route.fulfill({
      json: {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "e2e",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "验收响应：古桥事故线索已记录。" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      },
    });
  });
  await page.route("**/api/backends/text-completions/generate", async (route) => {
    generated.push({ at: Date.now(), body: route.request().postDataJSON(), api: "text" });
    await route.fulfill({ json: { results: [{ text: "验收响应：古桥事故线索已记录。" }] } });
  });
  const endpoint = `${embedding.baseUrl.replace(/\/$/, "")}/embeddings`;
  await page.route(
    (url) => url.href === endpoint,
    async (route) => {
      const timing = {
        call: embeddingCalls + 1,
        startedAt: Date.now(),
        responseAt: null,
        endedAt: null,
        durationMs: null,
        status: null,
        synthetic,
      };
      embeddingTimings.push(timing);
      try {
        embeddingCalls++;
        embeddingStarted = Date.now();
        console.log("Embedding request", embeddingCalls, route.request().method());
        if (synthetic) {
          timing.responseAt = Date.now();
          timing.status = 200;
          const input = route.request().postDataJSON().input;
          const inputs = Array.isArray(input) ? input : [input];
          if (embeddingDelay) await new Promise((resolve) => setTimeout(resolve, embeddingDelay));
          embeddingFinished = Date.now();
          if (route.request().failure()) {
            await route.abort("aborted");
            return;
          }
          await route.fulfill({
            json: {
              object: "list",
              model: embedding.model,
              data: inputs.map((text, index) => ({
                object: "embedding",
                index,
                embedding: [1, String(text).includes("古桥") ? 1 : 0, 0.1],
              })),
            },
            headers: { "access-control-allow-origin": "*" },
          });
          return;
        }
        // The request reaches the real configured embedding service. Delay only its delivery.
        const response = await route.fetch();
        timing.responseAt = Date.now();
        timing.status = response.status();
        assert(response.ok(), `Real embedding failed: ${response.status()}`);
        realEmbeddingCalls++;
        console.log("Embedding response", realEmbeddingCalls, response.status());
        if (embeddingDelay) await new Promise((resolve) => setTimeout(resolve, embeddingDelay));
        embeddingFinished = Date.now();
        if (route.request().failure()) {
          await route.abort("aborted");
          return;
        }
        await route.fulfill({
          response,
          headers: { ...response.headers(), "access-control-allow-origin": "*" },
        });
      } catch (error) {
        const message = safeError(error);
        pageErrors.push(message);
        console.error("Embedding route failed:", message);
        timing.error = message;
        try {
          await route.abort("failed");
        } catch (abortError) {
          pageErrors.push(safeError(abortError));
        }
      } finally {
        timing.endedAt = Date.now();
        timing.durationMs = timing.endedAt - timing.startedAt;
      }
    },
  );
  console.log("Loading ST");
  await page.goto(stUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => Boolean(window.__STE_MEMORY_RUNTIME__), null, {
    timeout: 60000,
  });
  console.log("Runtime ready; capturing settings");
  await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, {
    timeout: 60000,
  });
  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const st = await import("/script.js");
    const { oai_settings } = await import("/scripts/openai.js");
    const { textgenerationwebui_settings } = await import("/scripts/textgen-settings.js");
    const { power_user } = await import("/scripts/power-user.js");
    window.__expressionOriginal = {
      settings: structuredClone(window.__STE_MEMORY_RUNTIME__.settings.read()),
      mainApi: ctx.mainApi,
      onlineStatus: ctx.onlineStatus,
      oai: structuredClone(oai_settings),
      textgen: structuredClone(textgenerationwebui_settings),
      tokenizer: power_user.tokenizer,
      avatar: ctx.characters[ctx.characterId]?.avatar,
    };
    st.changeMainAPI("openai");
    oai_settings.chat_completion_source = "custom";
    oai_settings.custom_url = "https://expression-e2e.invalid/v1";
    oai_settings.custom_model = "e2e";
    oai_settings.stream_openai = false;
    st.setOnlineStatus("e2e-ready");
    const runtime = window.__STE_MEMORY_RUNTIME__;
    runtime.settingsService.save({
      ...runtime.settings.read(),
      enabled: true,
      macros: [],
      autoFill: { ...runtime.settings.read().autoFill, enabled: false },
      macroName: "steExpression",
      macroLimit: 10000,
    });
    await runtime.macro.kick();
  });
  settingsCaptured = true;
  console.log("ST initialized; creating dedicated characters");
  const avatarA = await createCharacter("A");
  const avatarB = await createCharacter("B");
  const spaceA = await selectCharacter(avatarA);
  const fixture = await page.evaluate(
    async ({ embedding, spaceId, stopProbe }) => {
      const r = window.__STE_MEMORY_RUNTIME__;
      await r.settingsService.setEmbeddingConnection(embedding);
      const table = await r.tables.create(spaceId, {
        key: "e2e_events",
        name: "验收事件",
        description: "",
        prompt: "",
        position: 100,
      });
      const field = await r.fields.create(spaceId, table.id, {
        key: "summary",
        name: "摘要",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
      });
      await r.fields.setDisplayStrategy(spaceId, table.id, { type: "field", fieldId: field.id });
      const group = {
        id: crypto.randomUUID(),
        key: "event_memory",
        name: "事件记忆",
        fieldIds: [field.id],
      };
      await r.tables.update(spaceId, table.id, {
        vectorIndex: { enabled: true, source: "custom", updateMode: "manual", groups: [group] },
      });
      const record = await r.records.create(spaceId, table.id, {
        payload: { [field.id]: "古桥事故调查发现红色披风" },
      });
      if (!stopProbe)
        await r.records.create(spaceId, table.id, {
          payload: { [field.id]: "图书馆开放时间是上午九点" },
        });
      const emptyTable = await r.tables.create(spaceId, {
        key: "e2e_empty",
        name: "无索引事件",
        description: "",
        prompt: "",
        position: 100,
      });
      const emptyField = await r.fields.create(spaceId, emptyTable.id, {
        key: "summary",
        name: "摘要",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
      });
      await r.fields.setDisplayStrategy(spaceId, emptyTable.id, {
        type: "field",
        fieldId: emptyField.id,
      });
      await r.tables.update(spaceId, emptyTable.id, {
        vectorIndex: {
          enabled: true,
          source: "custom",
          updateMode: "manual",
          groups: [
            {
              id: crypto.randomUUID(),
              key: "empty_memory",
              name: "空组",
              fieldIds: [emptyField.id],
            },
          ],
        },
      });
      await r.records.create(spaceId, emptyTable.id, {
        payload: { [emptyField.id]: "没有可用向量的记录" },
      });
      const query = {
        table: "e2e_events",
        fields: ["summary", "$similarity"],
        semantic: { groups: ["event_memory"], query: { context: "last_user_message" } },
        orderBy: { field: "$similarity", direction: "desc" },
        limit: 1,
      };
      const base = { enabled: true, output: { format: "json", maxChars: 10000 } };
      const macros = [
        {
          ...base,
          id: crypto.randomUUID(),
          name: "semantic",
          expression: { language: "query", query },
        },
        {
          ...base,
          id: crypto.randomUUID(),
          name: "semantic_sql",
          expression: {
            language: "sql",
            sources: [
              {
                name: "related",
                table: "e2e_events",
                groups: ["event_memory"],
                query: { context: "last_user_message" },
              },
            ],
            sql: 'SELECT e.summary AS "摘要", s.score AS "$similarity" FROM e2e_events e JOIN related s ON s.record_id = e."$record_id" ORDER BY s.score DESC, e."$record_id" LIMIT 1',
          },
        },
        {
          ...base,
          id: crypto.randomUUID(),
          name: "left_empty",
          expression: {
            language: "sql",
            sources: [
              {
                name: "empty_scores",
                table: "e2e_empty",
                groups: ["empty_memory"],
                query: { context: "last_user_message" },
              },
            ],
            sql: 'SELECT e.summary, s.score FROM e2e_empty e LEFT JOIN empty_scores s ON s.record_id=e."$record_id"',
          },
        },
      ];
      await r.settingsService.setChatScopeMacros(macros);
      await r.vector.submit({ memorySpaceId: spaceId, tableId: table.id }, { source: "manual" });
      return { tableId: table.id, fieldId: field.id, recordId: record.id, macros };
    },
    { embedding, spaceId: spaceA, stopProbe: stopProbe || tcProbe },
  );
  if (stopProbe || tcProbe)
    await page.evaluate(async () => {
      const ctx = SillyTavern.getContext();
      const extensions = await import("/scripts/extensions.js");
      const selected = new Map(
        [
          "GENERATION_STARTED",
          "GENERATION_AFTER_COMMANDS",
          "GENERATION_ENDED",
          "GENERATION_STOPPED",
          "MESSAGE_SENT",
          "USER_MESSAGE_RENDERED",
          "GENERATE_AFTER_DATA",
        ].map((name) => [ctx.eventTypes[name], name]),
      );
      const log = [];
      window.__expressionProbeLog = log;
      const emit = ctx.eventSource.emit;
      ctx.eventSource.emit = async function (type, ...args) {
        const name = selected.get(type);
        if (name)
          log.push({
            event: name,
            phase: "begin",
            at: performance.now(),
            preparing: window.__STE_MEMORY_RUNTIME__.macro.isPreparing(),
            type: typeof args[0] === "string" ? args[0] : undefined,
            ...(name === "GENERATION_STARTED" || name === "GENERATION_AFTER_COMMANDS"
              ? {
                  dryRun: args[2] === true,
                  options: {
                    automatic_trigger: args[1]?.automatic_trigger,
                    force_name2: args[1]?.force_name2,
                    signalAborted: args[1]?.signal?.aborted,
                  },
                }
              : {}),
          });
        try {
          return await emit.call(this, type, ...args);
        } finally {
          if (name) log.push({ event: name, phase: "end", at: performance.now() });
        }
      };
      const registry = extensions.extensionNames
        .map((name) => ({ name, ...extensions.getExtensionManifest(name) }))
        .filter((manifest) => manifest.generate_interceptor)
        .sort(
          (a, b) =>
            parseInt(a.loading_order) - parseInt(b.loading_order) ||
            String(a.display_name).localeCompare(String(b.display_name)),
        );
      window.__expressionProbeManifest = {
        manifestsExported: "manifests" in extensions,
        interceptors: registry.map(
          ({ name, display_name, loading_order, generate_interceptor }) => ({
            name,
            display_name,
            loading_order,
            generate_interceptor,
            globalType: typeof window[generate_interceptor],
          }),
        ),
      };
      for (const manifest of registry) {
        const key = manifest.generate_interceptor;
        const interceptor = window[key];
        if (typeof interceptor !== "function") continue;
        window[key] = function (...args) {
          log.push({
            event: "INTERCEPTOR",
            phase: "begin",
            key,
            type: args[3],
            at: performance.now(),
          });
          const abort = args[2];
          args[2] = function (immediately) {
            log.push({ event: "INTERCEPTOR_ABORT", key, immediately, at: performance.now() });
            return abort(immediately);
          };
          const result = interceptor.apply(this, args);
          if (result && typeof result.then === "function")
            return result.then((value) => {
              log.push({ event: "INTERCEPTOR", phase: "end", key, at: performance.now() });
              return value;
            });
          log.push({ event: "INTERCEPTOR", phase: "end", key, at: performance.now() });
          return result;
        };
      }
    });
  await check(synthetic ? "合成 embedding 建立索引" : "真实 embedding 建立索引", async () => {
    const deadline = Date.now() + 90000;
    let tasks;
    do {
      tasks = await page.evaluate(
        ({ space, table }) =>
          window.__STE_MEMORY_RUNTIME__.vector.listTasks({ memorySpaceId: space, tableId: table }),
        { space: spaceA, table: fixture.tableId },
      );
      if (
        tasks.items.length === (stopProbe || tcProbe ? 1 : 2) &&
        tasks.items.every((task) => task.status === "succeeded")
      )
        break;
      if (tasks.items.some((task) => task.status === "failed"))
        throw new Error(
          `Index task failed: ${tasks.items.map((task) => task.error ?? task.status).join("; ")}`,
        );
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    assert.equal(tasks.items.length, stopProbe || tcProbe ? 1 : 2);
    assert(
      tasks.items.every((task) => task.status === "succeeded"),
      "Index tasks did not finish before deadline",
    );
    console.log("Index requests observed", { embeddingCalls, realEmbeddingCalls });
    assert(synthetic ? embeddingCalls >= 1 : realEmbeddingCalls >= 1);
    return { realRequests: realEmbeddingCalls };
  });
  await check("无后台求值与 memoryRecall 注册", async () => {
    const result = await page.evaluate(() => ({
      recent: window.__STE_MEMORY_RUNTIME__.macro.getRecentResults(),
      recall: SillyTavern.getContext().macros.registry.hasMacro("memoryRecall"),
      runtimeRecall: "memoryRecall" in window.__STE_MEMORY_RUNTIME__,
    }));
    assert.equal(result.recall, false);
    assert.equal(result.runtimeRecall, false);
    assert.equal(result.recent.length, 0);
  });
  await check("显式 Query/SQL 测试等价且空源 LEFT JOIN 保留记录", async () => {
    const before = embeddingCalls;
    const result = await page.evaluate(async (macros) => {
      const r = window.__STE_MEMORY_RUNTIME__;
      const results = [];
      for (const macro of macros)
        results.push(
          await r.macro.testMacro({ macro, scope: "chat", lastUserMessage: "古桥事故" }),
        );
      return { results, recent: r.macro.getRecentResults() };
    }, fixture.macros);
    assert.equal(result.results[0].status, "success");
    assert.equal(result.results[1].status, "success");
    const queryRows = JSON.parse(result.results[0].text);
    const sqlRows = JSON.parse(result.results[1].text);
    assert.equal(queryRows[0]["摘要"], sqlRows[0]["摘要"]);
    assert(
      Math.abs(queryRows[0]["$similarity"] - sqlRows[0]["$similarity"]) < 0.02,
      "Independent real embedding calls diverged unexpectedly",
    );
    assert.equal(result.results[2].resultRows, 1);
    assert.equal(JSON.parse(result.results[2].text)[0].score, null);
    assert.equal(result.recent.length, 0);
    assert.equal(embeddingCalls - before, 2);
    return result.results.map(({ name, status, resultRows }) => ({ name, status, resultRows }));
  });
  await check("宏 UI 最近结果只读、表达式编辑和显式测试入口", async () => {
    await page.locator("#top-settings-holder .stm-toolbar-button").click();
    await switchTab(page, "settings");
    await openSettingsGroup(page, "macro");
    await page.locator('[data-macro-scope="chat"]').click();
    const before = embeddingCalls;
    await page
      .locator("[data-macro-id]")
      .filter({ hasText: "semantic" })
      .first()
      .getByRole("button", { name: "编辑 / 改名" })
      .click();
    await page.getByLabel("Query JSON", { exact: true }).waitFor();
    assert(await page.getByLabel("last_user_message 测试文本").count());
    await page.getByLabel("宏名", { exact: true }).fill("semantic_edited");
    await page.getByRole("button", { name: "保存宏", exact: true }).click();
    await page.waitForFunction(
      (id) =>
        window.__STE_MEMORY_RUNTIME__.cleaning
          .readChatScopeMacros()
          .some((macro) => macro.id === id && macro.name === "semantic_edited"),
      fixture.macros[0].id,
    );
    await page
      .locator(`[data-macro-id="${fixture.macros[0].id}"]`)
      .getByRole("button", { name: "编辑 / 改名" })
      .click();
    await page.getByLabel("宏名", { exact: true }).fill("semantic");
    await page.getByRole("button", { name: "保存宏", exact: true }).click();
    await page.waitForFunction(
      (id) =>
        window.__STE_MEMORY_RUNTIME__.cleaning
          .readChatScopeMacros()
          .some((macro) => macro.id === id && macro.name === "semantic"),
      fixture.macros[0].id,
    );
    assert.equal(embeddingCalls, before);
    await page.screenshot({ path: path.join(output, "macros.png"), fullPage: true });
    await page.locator("#top-settings-holder .stm-toolbar-button").click();
  });
  if (!stopProbe)
    await page.evaluate(async (name) => {
      const ctx = SillyTavern.getContext();
      await ctx.saveWorldInfo(
        name,
        {
          entries: {
            0: {
              uid: 0,
              key: ["古桥事故"],
              keysecondary: [],
              content: "WI_MATCH {{steExpression::semantic}} END_WI",
              constant: false,
              selective: false,
              order: 100,
              position: 0,
              disable: false,
              excludeRecursion: false,
              preventRecursion: false,
              delayUntilRecursion: false,
              probability: 100,
              useProbability: false,
              depth: 4,
              group: "",
              groupOverride: false,
              groupWeight: 100,
              scanDepth: null,
              caseSensitive: null,
              matchWholeWords: false,
              useGroupScoring: null,
              automationId: "",
              role: 0,
              sticky: 0,
              cooldown: 0,
              delay: 0,
              displayIndex: 0,
              addMemo: false,
            },
          },
        },
        true,
      );
      await ctx.updateWorldInfoList();
      ctx.chatMetadata.world_info = name;
      ctx.saveMetadataDebounced();
    }, worldBook);
  worldCreated = !stopProbe;
  await check("真实正常生成等待宏、同批一次 embedding、提示词命中", async () => {
    const before = embeddingCalls;
    const generationCount = generated.length;
    embeddingDelay = 1200;
    await generate();
    await page.waitForFunction(() => window.__STE_MEMORY_RUNTIME__.macro.isPreparing(), null, {
      timeout: 10000,
    });
    assert.equal(
      generated.length,
      generationCount,
      "Main generation request escaped before macro completion",
    );
    await finishGeneration();
    await waitForEvaluation();
    embeddingDelay = 0;
    assert.equal(embeddingCalls - before, 1);
    assert.equal(generated.length, generationCount + 1);
    assert(generated.at(-1).at >= embeddingFinished);
    const prompt = JSON.stringify(generated.at(-1).body);
    assert(prompt.includes("红色披风"));
    assert(prompt.includes("WI_MATCH"), "Real keyword-activated world info entry absent");
    assert(prompt.slice(prompt.indexOf("WI_MATCH"), prompt.indexOf("END_WI")).includes("红色披风"));
    const rows = await recent();
    assert.deepEqual(
      JSON.parse(rows.find((row) => row.name === "semantic").text),
      JSON.parse(rows.find((row) => row.name === "semantic_sql").text),
    );
    assert(
      rows
        .filter((row) => row.name.startsWith("semantic"))
        .every((row) => row.status === "success"),
    );
    return {
      embeddingRequests: embeddingCalls - before,
      waitedMs: embeddingFinished - embeddingStarted,
      resultRows: rows.map(({ name, status, resultRows }) => ({ name, status, resultRows })),
    };
  });
  for (const type of ["regenerate", "swipe", "continue"])
    await check(`真实 ${type} 重新求值`, async () => {
      const before = embeddingCalls;
      await generate(type);
      await finishGeneration();
      assert.equal(embeddingCalls - before, 1);
      assert(JSON.stringify(generated.at(-1).body).includes("红色披风"));
    });
  await check("独立 dry run 与 quiet 不请求查询向量", async () => {
    const before = embeddingCalls;
    await page.evaluate(async () => {
      const ctx = SillyTavern.getContext();
      await ctx.generate("normal", {}, true);
      await ctx.generate("quiet", { quiet_prompt: "只回复验收完成" });
    });
    assert.equal(embeddingCalls, before);
  });
  await check("Text Completion 真实提示词构建使用本批宏与世界书", async () => {
    await page.evaluate(async () => {
      const st = await import("/script.js");
      const { textgenerationwebui_settings: t } = await import("/scripts/textgen-settings.js");
      const { power_user } = await import("/scripts/power-user.js");
      t.type = "generic";
      t.server_urls.generic = "http://expression-e2e.invalid";
      t.generic_model = "e2e";
      t.streaming = false;
      power_user.tokenizer = 0;
      st.changeMainAPI("textgenerationwebui");
      st.setOnlineStatus("e2e-ready");
    });
    diagnostics.textCompletion = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = embeddingCalls;
      const requestStart = generated.length;
      const startedAt = Date.now();
      if (tcProbe) embeddingDelay = 1800;
      await generate("normal", `古桥事故 Text Completion 验收 ${attempt + 1}`);
      await finishGeneration();
      const state = await page.evaluate(() => ({
        preparing: window.__STE_MEMORY_RUNTIME__.macro.isPreparing(),
        settled: window.__expressionGenerationSettled,
        statuses: window.__STE_MEMORY_RUNTIME__.macro
          .getRecentResults()
          .filter((row) => row.name.startsWith("semantic"))
          .map(({ name, status, error, elapsedMs, startedAt }) => ({
            name,
            status,
            error,
            elapsedMs,
            startedAt,
          })),
      }));
      state.statuses = state.statuses.map((row) => ({
        ...row,
        error: row.error === null ? null : safeError(row.error),
      }));
      const request = generated.slice(requestStart).find((request) => request.api === "text");
      const prompt = request ? JSON.stringify(request.body) : "";
      const timedOut = state.statuses.some(
        (row) =>
          row.status === "error" && /超时|超过.*秒|timeout|timed.?out/i.test(row.error ?? ""),
      );
      const detail = {
        attempt: attempt + 1,
        startedAt,
        finishedAt: Date.now(),
        mainAt: request?.at ?? null,
        hasRed: prompt.includes("红色披风"),
        hasWI: prompt.includes("WI_MATCH"),
        timedOut,
        ...state,
      };
      diagnostics.textCompletion.push(detail);
      console.log("TC timing", JSON.stringify(detail));
      if (tcProbe) {
        console.log(
          "TC PROBE",
          JSON.stringify({
            events: await page.evaluate(() => window.__expressionProbeLog),
            ...detail,
          }),
        );
        embeddingDelay = 0;
      }
      assert.equal(embeddingCalls - before, 1);
      assert(request, "Text Completion main request missing");
      if (!detail.hasRed && timedOut && attempt === 0) {
        assert(
          request.at - startedAt >= 9000,
          "Timeout must respect the production ten-second budget",
        );
        console.log("TC reached production deadline; retrying this acceptance operation once");
        continue;
      }
      assert(detail.hasRed, "Text Completion prompt missing successful macro output");
      assert(detail.hasWI);
      break;
    }
    await page.evaluate(async () => {
      const st = await import("/script.js");
      st.changeMainAPI("openai");
      st.setOnlineStatus("e2e-ready");
    });
    return {
      attempts: diagnostics.textCompletion.length,
      timeoutObserved: diagnostics.textCompletion.some((row) => row.timedOut),
    };
  });
  await check("跳过本次计算继续主生成且迟到响应不替换", async () => {
    embeddingDelay = 1800;
    const mainBefore = generated.length;
    const request = page.waitForRequest(
      (request) => request.url() === endpoint && request.method() === "POST",
    );
    await generate("normal", "古桥事故 跳过测试");
    await request;
    await page.waitForFunction(() => window.__STE_MEMORY_RUNTIME__.macro.isPreparing());
    await page.evaluate(() => window.__STE_MEMORY_RUNTIME__.macro.skip());
    await finishGeneration();
    const snapshot = await recent();
    assert(
      snapshot.filter((row) => row.name.startsWith("semantic")).every((row) => row.text === ""),
    );
    assert.equal(generated.length, mainBefore + 1);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    embeddingDelay = 0;
    assert.deepEqual(await recent(), snapshot);
  });
  await check("群聊 wrapper 真实事件中的两次生成共用一次宏求值", async () => {
    const before = embeddingCalls;
    await page.evaluate(async () => {
      const ctx = SillyTavern.getContext();
      await ctx.eventSource.emit(ctx.eventTypes.GROUP_WRAPPER_STARTED, {
        selected_group: "expression-e2e",
        type: "normal",
      });
    });
    try {
      await generate("regenerate");
      await finishGeneration();
      await generate("regenerate");
      await finishGeneration();
      assert.equal(embeddingCalls - before, 1);
    } finally {
      await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        await ctx.eventSource.emit(ctx.eventTypes.GROUP_WRAPPER_FINISHED, {
          selected_group: "expression-e2e",
          type: "normal",
        });
      });
    }
    return "真实group wrapper事件与两次真实生成；未创建完整群聊会话";
  });
  await check("ST 停止取消未完成计算，迟到结果不发布", async () => {
    const before = embeddingCalls;
    embeddingDelay = 1800;
    const request = page.waitForRequest(
      (request) => request.url() === endpoint && request.method() === "POST",
    );
    await generate("normal", "取消场景的古桥事故");
    await request;
    await page.waitForFunction(() => window.__STE_MEMORY_RUNTIME__.macro.isPreparing());
    await page.evaluate(() => SillyTavern.getContext().stopGeneration());
    await finishGeneration();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    embeddingDelay = 0;
    assert(embeddingCalls >= before + 1);
    assert((await recent()).every((row) => row.status !== "success"));
    if (stopProbe) {
      const stoppedSettled = await page.evaluate(() => window.__expressionGenerationSettled);
      await generate("normal", "古桥事故 stop后下一次发送探针");
      await page.waitForTimeout(3000);
      const probe = await page.evaluate(() => ({
        manifest: window.__expressionProbeManifest,
        events: window.__expressionProbeLog,
        preparing: window.__STE_MEMORY_RUNTIME__.macro.isPreparing(),
        nextPromiseSettled: window.__expressionGenerationSettled,
        nextPromiseError: window.__expressionGenerationError,
        statuses: window.__STE_MEMORY_RUNTIME__.macro
          .getRecentResults()
          .map(({ name, status }) => ({ name, status })),
      }));
      console.log("STOP PROBE", JSON.stringify({ ...probe, stoppedSettled }));
      return { ...probe, stoppedSettled };
    }
  });
  await check("切换对话隔离迟到结果并保留对话宏定义", async () => {
    embeddingDelay = 3000;
    const request = page.waitForRequest(
      (request) => request.url() === endpoint && request.method() === "POST",
    );
    await generate("normal", "切换场景古桥事故");
    await request;
    await page.waitForFunction(() => window.__STE_MEMORY_RUNTIME__.macro.isPreparing());
    // The host rejects character selection while is_send_press is true. Stop first,
    // then switch while the upstream HTTP response is still deliberately delayed.
    await page.evaluate(() => SillyTavern.getContext().stopGeneration());
    await finishGeneration();
    const spaceB = await selectCharacter(avatarB);
    assert.notEqual(spaceB, spaceA);
    assert.deepEqual(await recent(), []);
    await selectCharacter(avatarA);
    assert(
      Date.now() - embeddingStarted < embeddingDelay,
      "A→B→A must finish before delayed response delivery",
    );
    await new Promise((resolve) => setTimeout(resolve, 3500));
    embeddingDelay = 0;
    assert.deepEqual(await recent(), []);
    const count = await page.evaluate(
      () => window.__STE_MEMORY_RUNTIME__.cleaning.readChatScopeMacros().length,
    );
    assert.equal(count, fixture.macros.length);
    return "宿主要求先STOP并等待旧Generate退出；HTTP仍延迟期间A→B→A，迟到不发布，定义保留";
  });
  await check("系统预设携带 Query 和停用语义宏示例", async () => {
    const response = await context.request.get(
      `${stUrl}/scripts/extensions/third-party/ste-memory/index.js`,
    );
    assert(response.ok());
    await page.locator("#top-settings-holder .stm-toolbar-button").click();
    await switchTab(page, "settings");
    await openSettingsGroup(page, "table-presets");
    const preset = page.locator('[data-action="open-table-preset"][data-preset-id="storyMemory"]');
    await preset.click();
    assert(await page.getByText("预设对话宏", { exact: true }).count());
    assert(await page.getByText("相关纪要", { exact: false }).count());
    await page.getByText("预设对话宏", { exact: true }).click();
    await page
      .locator(".stm-setting-row")
      .filter({ hasText: "相关纪要" })
      .getByRole("button", { name: "编辑宏", exact: true })
      .click();
    await page.getByLabel("宏名", { exact: true }).fill("相关纪要_验收");
    const before = embeddingCalls;
    await page.getByRole("button", { name: "保存宏", exact: true }).click();
    await page.waitForFunction(() =>
      window.__STE_MEMORY_RUNTIME__.settings
        .read()
        .tablePresets.userPresets.some((preset) =>
          preset.macros?.some((macro) => macro.name === "相关纪要_验收"),
        ),
    );
    const saved = await page.evaluate(() =>
      window.__STE_MEMORY_RUNTIME__.settings
        .read()
        .tablePresets.userPresets.find((preset) =>
          preset.macros?.some((macro) => macro.name === "相关纪要_验收"),
        ),
    );
    assert(saved.macros.length >= 2);
    assert.equal(embeddingCalls, before);
    await page
      .locator(".stm-setting-row")
      .filter({ hasText: "相关纪要_验收" })
      .getByRole("button", { name: "编辑宏", exact: true })
      .click();
    await page.getByLabel("表达式语言", { exact: true }).selectOption("sql");
    await page.getByLabel("SQL 正文", { exact: true }).fill("DELETE FROM chronicle");
    await page.getByRole("button", { name: "保存宏", exact: true }).click();
    await page
      .locator('[data-expression-macro-editor] [role="alert"]')
      .waitFor({ state: "visible" });
    assert.equal(
      await page.getByLabel("SQL 正文", { exact: true }).inputValue(),
      "DELETE FROM chronicle",
    );
    const persisted = await page.evaluate(
      (id) =>
        window.__STE_MEMORY_RUNTIME__.settings
          .read()
          .tablePresets.userPresets.find((preset) => preset.id === id),
      saved.id,
    );
    assert.equal(
      persisted.macros.find((macro) => macro.name === "相关纪要_验收").expression.language,
      "query",
    );
    assert.equal(embeddingCalls, before);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.screenshot({ path: path.join(output, "preset-macros.png"), fullPage: true });
  });
} catch (error) {
  console.error("Acceptance stage failed:", safeError(error));
  if (!checks.some((row) => !row.ok))
    checks.push({ name: "setup / acceptance", ok: false, error: safeError(error) });
} finally {
  try {
    if (settingsCaptured)
      await page.evaluate(
        async ({ avatars, spaceIds, worldBook, worldCreated }) => {
          const runtime = window.__STE_MEMORY_RUNTIME__;
          const ctx = SillyTavern.getContext();
          const st = await import("/script.js");
          const { oai_settings } = await import("/scripts/openai.js");
          ctx.stopGeneration();
          runtime.macro.cancel("验收清理");
          for (const id of spaceIds) {
            await runtime.vector.purge({ memorySpaceId: id });
            await runtime.spaces.delete(id);
          }
          const original = window.__expressionOriginal;
          runtime.settingsService.save(original.settings);
          await runtime.macro.kick();
          Object.assign(oai_settings, original.oai);
          const { textgenerationwebui_settings } = await import("/scripts/textgen-settings.js");
          const { power_user } = await import("/scripts/power-user.js");
          Object.assign(textgenerationwebui_settings, original.textgen);
          power_user.tokenizer = original.tokenizer;
          st.changeMainAPI(original.mainApi);
          st.setOnlineStatus(original.onlineStatus);
          if (worldCreated) {
            if (ctx.chatMetadata.world_info === worldBook) delete ctx.chatMetadata.world_info;
            const response = await fetch("/api/worldinfo/delete", {
              method: "POST",
              headers: ctx.getRequestHeaders(),
              body: JSON.stringify({ name: worldBook }),
            });
            if (!response.ok) throw new Error(`World cleanup failed: ${response.status}`);
          }
          if (original.avatar) {
            const index = ctx.characters.findIndex(
              (character) => character.avatar === original.avatar,
            );
            if (index >= 0) await ctx.selectCharacterById(index);
          }
          for (const avatar of avatars) {
            const response = await fetch("/api/characters/delete", {
              method: "POST",
              headers: ctx.getRequestHeaders(),
              body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
            });
            if (!response.ok) throw new Error(`Test character cleanup failed: ${response.status}`);
          }
          ctx.saveSettingsDebounced();
        },
        { avatars: characters, spaceIds: [...spaces], worldBook, worldCreated },
      );
    await page.waitForTimeout(2500);
    checks.push({ name: "清理专用角色/对话/空间并恢复设置", ok: true });
  } catch (error) {
    checks.push({ name: "清理", ok: false, error: safeError(error) });
  }
  await page.unrouteAll({ behavior: "wait" });
  await browser.close();
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        runId,
        mode: stopProbe ? "stop-probe" : tcProbe ? "tc-probe" : "full",
        synthetic,
        artifactHashes,
        checks,
        pageErrors,
        diagnostics,
        embeddingTimings,
        realEmbeddingCalls,
        embeddingCalls,
      },
      null,
      2,
    ),
    "utf8",
  );
}
console.log(
  `${checks.filter((row) => row.ok).length}/${checks.length} checks passed; report: ${path.join(output, "report.json")}`,
);
process.exitCode = checks.every((row) => row.ok) ? 0 : 1;
