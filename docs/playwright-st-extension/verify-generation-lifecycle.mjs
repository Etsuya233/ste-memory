// Real ST generation, macro engine and chat files; only the model HTTP response is controlled.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

assert.ok(
  process.env.ST_URL && process.env.ST_IMPORT_TEST_INSTANCE === "1",
  "Use an isolated ST test instance",
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-proxy-server"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const errors = [];
const results = [];
const requests = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (label, value) => {
  assert.ok(value, label);
  results.push(label);
  console.log(`PASS ${label}`);
};
const state = () =>
  page.evaluate(() => ({
    macro: window.__STE_MEMORY_RUNTIME__.macro.getGenerationState(),
    autoFill: window.__STE_MEMORY_RUNTIME__.autoFill.getGenerationState(),
    chat: SillyTavern.getContext().chat.map((row) => ({ text: row.mes, isUser: row.is_user })),
  }));
async function openChat(chatId) {
  await page.evaluate(async (chatId) => {
    await SillyTavern.getContext().selectCharacterById(0);
    await SillyTavern.getContext().openCharacterChat(chatId);
  }, chatId);
  await page.waitForFunction((chatId) => {
    const runtime = window.__STE_MEMORY_RUNTIME__;
    return (
      runtime?.manager.getStatus()?.kind === "active" &&
      runtime.adapter.captureFileTarget()?.chatId === chatId
    );
  }, chatId);
}
async function configure(marker) {
  await page.evaluate(async (marker) => {
    const context = SillyTavern.getContext();
    Object.assign(context.chatCompletionSettings, {
      stream_openai: false,
      n: 1,
      openai_model: "gpt-4o-mini",
    });
    const { setOnlineStatus, extension_prompt_types } = await import("/script.js");
    setOnlineStatus("isolated-e2e");
    context.setExtensionPrompt(
      "ste-generation-e2e",
      "Lifecycle memory: {{ste::lifecycle}}",
      extension_prompt_types.IN_CHAT,
      0,
    );
    const runtime = window.__STE_MEMORY_RUNTIME__;
    runtime.settings.write({
      ...runtime.settings.read(),
      macroName: "{{ste}}",
      autoFill: {
        ...runtime.settings.read().autoFill,
        mode: "remind",
        interval: 1,
        delayFloors: 0,
      },
      macros: [
        {
          id: "generation-e2e",
          name: "lifecycle",
          enabled: true,
          expression: { language: "sql", sql: `SELECT '${marker}' AS memory` },
          output: { format: "text", maxChars: null },
        },
      ],
    });
    await runtime.macro.kick();
  }, marker);
}
async function generate(type, text) {
  return page.evaluate(
    async ({ type, text }) => {
      if (text !== undefined) {
        document.querySelector("#send_textarea").value = text;
      }
      await SillyTavern.getContext().generate(type);
    },
    { type, text },
  );
}
let responseMode = "success";
try {
  await page.route("**/api/backends/chat-completions/generate", async (route) => {
    requests.push(route.request().postDataJSON());
    if (responseMode === "hold") {
      // The browser aborts this real ST request through stopGeneration().
      return;
    }
    if (responseMode === "failure") {
      await route.fulfill({
        status: 503,
        body: JSON.stringify({ error: { message: "isolated model failure" } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Dedicated response ${requests.length}` },
            finish_reason: "stop",
          },
        ],
      }),
    });
  });
  await page.goto(process.env.ST_URL);
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await page.locator("#preloader").waitFor({ state: "hidden" });
  const chatA = `ste-generation-A-${Date.now()}`;
  const chatB = `ste-generation-B-${Date.now()}`;
  await openChat(chatA);
  await configure("fresh-send-marker");
  await generate("normal", "Dedicated lifecycle test {{ste::lifecycle}}");
  const sent = await state();
  check(
    "native send expands the evaluated macro into the model request",
    JSON.stringify(requests.at(-1).messages).includes("fresh-send-marker") &&
      !JSON.stringify(requests.at(-1).messages).includes("{{ste::lifecycle}}"),
  );
  check(
    "native response completes one generation shared by macros and auto-fill",
    sent.autoFill.kind === "completed" &&
      sent.macro.phase === "finished" &&
      sent.autoFill.generation.id === sent.macro.generation.id,
  );
  check("finished generation closes synchronous macro readability", !sent.macro.readable);

  await configure("fresh-regenerate-marker");
  await generate("regenerate");
  const regenerated = await state();
  check(
    "native regenerate evaluates a fresh macro batch",
    JSON.stringify(requests.at(-1).messages).includes("fresh-regenerate-marker") &&
      regenerated.macro.batchId !== sent.macro.batchId,
  );
  check(
    "regenerate receives a distinct foreground identity",
    regenerated.autoFill.kind === "completed" &&
      regenerated.autoFill.generation.id !== sent.autoFill.generation.id,
  );

  await configure("fresh-continue-marker");
  await generate("continue");
  const continued = await state();
  check(
    "native continue evaluates a fresh batch instead of tool-recursion reuse",
    JSON.stringify(requests.at(-1).messages).includes("fresh-continue-marker") &&
      continued.macro.batchId !== regenerated.macro.batchId,
  );

  responseMode = "hold";
  const beforeStop = requests.length;
  const stoppedRequest = page.waitForRequest("**/api/backends/chat-completions/generate");
  await page.evaluate(() => {
    document.querySelector("#send_textarea").value =
      "Stop this dedicated request {{ste::lifecycle}}";
    window.generationE2ePending = SillyTavern.getContext()
      .generate("normal")
      .catch((error) => String(error));
  });
  await stoppedRequest;
  await page.evaluate(() => SillyTavern.getContext().stopGeneration());
  await page.evaluate(() => window.generationE2ePending);
  const stopped = await state();
  check(
    "native stop revokes macro readability and automatic reply authorization",
    requests.length === beforeStop + 1 &&
      !stopped.macro.readable &&
      stopped.autoFill.kind === "stopped",
  );
  responseMode = "success";
  await generate("normal", "A fresh request after stop {{ste::lifecycle}}");
  const restarted = await state();
  check(
    "a new native generation succeeds after stopping the previous request",
    restarted.autoFill.kind === "completed" &&
      restarted.autoFill.generation.id !== stopped.autoFill.generation.id,
  );

  responseMode = "failure";
  await generate("normal", "A failed dedicated request {{ste::lifecycle}}").catch(() => {});
  const failed = await state();
  check(
    "failed native model response grants no completed reply",
    failed.autoFill.kind === "ended-awaiting-reply" && !failed.macro.readable,
  );
  responseMode = "success";
  await openChat(chatB);
  check(
    "switching to a fresh native chat clears generation ownership",
    (await state()).autoFill.kind === "idle",
  );
  await openChat(chatA);
  check(
    "A to B to A does not revive a previous generation",
    (await state()).autoFill.kind === "idle" && !(await state()).macro.readable,
  );
  await page.reload();
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await openChat(chatA);
  check(
    "native saved chat survives reload without granting automatic generation",
    (await state()).chat.some((row) => row.text.includes("Dedicated response")) &&
      (await state()).autoFill.kind === "idle",
  );
  const groupId = await page.evaluate(async () => {
    const context = SillyTavern.getContext();
    const response = await fetch("/api/groups/create", {
      method: "POST",
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        name: `ste-generation-group-${Date.now()}`,
        members: [context.characters[0].avatar],
        activation_strategy: 1,
        allow_self_responses: true,
      }),
    });
    if (!response.ok) {
      throw new Error(`Cannot create test group: ${response.status}`);
    }
    const group = await response.json();
    context.groups.push(group);
    const { openGroupById } = await import("/scripts/group-chats.js");
    if (!(await openGroupById(group.id))) {
      throw new Error("Cannot open dedicated generation group");
    }
    return group.id;
  });
  await page.waitForFunction((groupId) => {
    const runtime = window.__STE_MEMORY_RUNTIME__;
    return (
      runtime?.manager.getStatus()?.kind === "active" &&
      runtime.adapter.captureFileTarget()?.kind === "group" &&
      SillyTavern.getContext().groupId === groupId
    );
  }, groupId);
  await configure("group-send-marker");
  await generate("normal", "A dedicated group question");
  const groupSent = await state();
  check(
    "native group send expands macros for its member generation",
    JSON.stringify(requests.at(-1).messages).includes("group-send-marker") &&
      groupSent.autoFill.kind === "completed",
  );
  await configure("group-regenerate-marker");
  await generate("regenerate");
  const groupRegenerated = await state();
  check(
    "native group regenerate reaches member generation without a wrapper deadlock",
    JSON.stringify(requests.at(-1).messages).includes("group-regenerate-marker") &&
      groupRegenerated.autoFill.kind === "completed" &&
      groupRegenerated.autoFill.generation.id !== groupSent.autoFill.generation.id,
  );
  await configure("group-continue-marker");
  await generate("continue");
  const groupContinued = await state();
  check(
    "native group continue evaluates a fresh batch",
    JSON.stringify(requests.at(-1).messages).includes("group-continue-marker") &&
      groupContinued.autoFill.generation.id !== groupRegenerated.autoFill.generation.id,
  );
  check(
    "native group wrapper completion revokes the cached readable batch",
    groupContinued.macro.groupId === null && !groupContinued.macro.readable,
  );
  check("no uncaught browser errors", errors.length === 0);
  if (process.env.ST_TEST_RESULTS) {
    await mkdir(path.dirname(process.env.ST_TEST_RESULTS), { recursive: true });
    await writeFile(
      process.env.ST_TEST_RESULTS,
      JSON.stringify(
        {
          results,
          errors,
          chatA,
          chatB,
          groupId,
          modelBoundary: "controlled HTTP responses; native ST pipeline and persistence",
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  console.log(`PASS ${results.length} real ST generation checks`);
} finally {
  await browser.close();
}
