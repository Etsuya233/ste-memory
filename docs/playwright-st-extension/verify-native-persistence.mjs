// Writes dedicated test chats. Use an isolated SillyTavern data root only.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

assert.ok(
  process.env.ST_URL &&
    process.env.ST_TEST_DATA_ROOT &&
    process.env.ST_IMPORT_TEST_INSTANCE === "1",
  "Set isolated ST_URL, ST_TEST_DATA_ROOT and ST_IMPORT_TEST_INSTANCE=1",
);
const results = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-proxy-server"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (label, value) => {
  assert.ok(value, label);
  results.push(label);
  console.log(`PASS ${label}`);
};
const app = (operation, argument) => page.evaluate(operation, argument);
const snapshot = () => app(() => window.__STE_MEMORY_RUNTIME__.backup.exportCurrentSpace());
async function ready(chatId) {
  await page.waitForFunction(
    (chatId) => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      const target = runtime?.adapter.captureFileTarget();
      return (
        runtime?.manager.getStatus()?.kind === "active" &&
        target?.chatId === chatId &&
        ["idle", "submitted", "verified"].includes(
          runtime.persistence.getStatus(target.identity).kind,
        )
      );
    },
    chatId,
    { timeout: 45000 },
  );
}
async function openChat(chatId, avatar) {
  await app(
    async ({ chatId, avatar }) => {
      const context = SillyTavern.getContext();
      const index = avatar ? context.characters.findIndex((row) => row.avatar === avatar) : 0;
      if (index < 0) {
        throw new Error("Dedicated test character is missing");
      }
      await context.selectCharacterById(index);
      await SillyTavern.getContext().openCharacterChat(chatId);
    },
    { chatId, avatar },
  );
  await ready(chatId);
}
async function disk(target) {
  assert.equal(target.kind, "character");
  const directory = target.avatarUrl.replace(/\.png$/i, "");
  const file = path.join(
    process.env.ST_TEST_DATA_ROOT,
    "default-user/chats",
    directory,
    `${target.chatId}.jsonl`,
  );
  const rows = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { metadata: rows[0].chat_metadata, messages: rows.slice(1).map((row) => row.mes) };
}
async function compareDisk(target, label) {
  const current = await snapshot();
  const saved = await disk(target);
  assert.deepEqual(saved.metadata.steMemoryMirror.data, JSON.parse(JSON.stringify(current)));
  assert.equal(saved.metadata.steMemory.spaceId, current.space.id);
  check(label, true);
  return saved;
}
let releaseSave;
try {
  await page.goto(process.env.ST_URL);
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await page.locator("#preloader").waitFor({ state: "hidden" });
  const chatA = `ste-native-A-${Date.now()}`;
  const chatB = `ste-native-B-${Date.now()}`;
  await openChat(chatA);
  const targetA = await app(() => window.__STE_MEMORY_RUNTIME__.adapter.captureFileTarget());
  const initial = await disk(targetA);
  const first = await app(async () => {
    const runtime = window.__STE_MEMORY_RUNTIME__;
    const unit = await runtime.backup.exportCurrentSpace();
    const table = unit.tables.find((row) => row.key === "characters");
    const field = unit.fields.find((row) => row.tableId === table.id && row.key === "name");
    const record = await runtime.records.create(unit.space.id, table.id, {
      payload: { [field.id]: "native-save-first" },
    });
    return { record, fieldId: field.id, tableId: table.id, spaceId: unit.space.id };
  });
  check(
    "ordinary save reports submitted, without claiming verification",
    await app(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      return (
        runtime.persistence.getStatus(runtime.adapter.captureFileTarget().identity).kind ===
        "submitted"
      );
    }),
  );
  const saved = await compareDisk(
    targetA,
    "ordinary native save matches the complete SQLite snapshot on disk",
  );
  assert.deepEqual(saved.messages, initial.messages);
  check("memory saving preserves native chat message text", true);
  await page.reload();
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await openChat(chatA, targetA.avatarUrl);
  check(
    "reload restores the ordinary saved record",
    (await snapshot()).records.some((row) => row.id === first.record.id),
  );

  await page.route("**/api/chats/save", (route) =>
    route.fulfill({ status: 503, body: "isolated native save failure" }),
  );
  const second = await app(async ({ fieldId, tableId, spaceId }) => {
    return window.__STE_MEMORY_RUNTIME__.records.create(spaceId, tableId, {
      payload: { [fieldId]: "native-save-recovery" },
    });
  }, first);
  check(
    "ST swallowed-save failure retains the committed record in SQLite",
    (await snapshot()).records.some((row) => row.id === second.id),
  );
  check(
    "blocked native save leaves the previous disk snapshot intact",
    !(await disk(targetA)).metadata.steMemoryMirror.data.records.some(
      (row) => row.id === second.id,
    ),
  );
  const failed = await app(async () => {
    const runtime = window.__STE_MEMORY_RUNTIME__;
    try {
      await runtime.forceSyncMemory();
    } catch {
      // The real native save may swallow HTTP errors; verification detects the old file.
    }
    return runtime.persistence.getStatus(runtime.adapter.captureFileTarget().identity);
  });
  check(
    "native force-sync detects the stale disk file at verification",
    failed.kind === "failed" && failed.phase === "verify",
  );
  await page.unroute("**/api/chats/save");
  await app(() => window.__STE_MEMORY_RUNTIME__.retryMemorySave());
  await compareDisk(targetA, "persistence retry writes the latest committed snapshot to disk");
  const recovered = await snapshot();
  check(
    "persistence recovery does not duplicate committed records",
    recovered.records.length === 2 && new Set(recovered.records.map((row) => row.id)).size === 2,
  );

  let signalSaving;
  const saving = new Promise((resolve) => {
    signalSaving = resolve;
  });
  const released = new Promise((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/api/chats/save",
    async (route) => {
      const response = await route.fetch();
      signalSaving();
      await released;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await app(({ record, fieldId, tableId, spaceId }) => {
    window.nativeE2eSave = window.__STE_MEMORY_RUNTIME__.records.update(
      spaceId,
      tableId,
      record.id,
      {
        expectedRevisionId: record.revisionId,
        patch: { [fieldId]: "native-save-during-switch" },
        revisionSource: "user",
      },
    );
  }, first);
  await saving;
  await app((chatId) => {
    window.nativeE2eSwitch = SillyTavern.getContext().openCharacterChat(chatId);
  }, chatB);
  releaseSave();
  await app(async () => {
    await window.nativeE2eSave;
    await window.nativeE2eSwitch;
    delete window.nativeE2eSave;
    delete window.nativeE2eSwitch;
  });
  await ready(chatB);
  const targetB = await app(() => window.__STE_MEMORY_RUNTIME__.adapter.captureFileTarget());
  check("switch requested during native saving finishes in the new chat", targetB.chatId === chatB);
  check(
    "new chat has an independent space and no old records",
    (await snapshot()).space.id !== first.spaceId && (await snapshot()).records.length === 0,
  );
  await compareDisk(targetB, "new chat file remains bound to its own complete snapshot");
  check(
    "late original save targets only its original chat file",
    (await disk(targetA)).metadata.steMemoryMirror.data.records.find(
      (row) => row.id === first.record.id,
    ).payload[first.fieldId] === "native-save-during-switch",
  );
  await openChat(chatA, targetA.avatarUrl);
  check(
    "A to B to A restores the original records and updated revision",
    (await snapshot()).records.find((row) => row.id === first.record.id).payload[first.fieldId] ===
      "native-save-during-switch" && (await snapshot()).records.length === 2,
  );
  await page.reload();
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await openChat(chatA, targetA.avatarUrl);
  await compareDisk(targetA, "final page reload restores the exact native file snapshot");
  check("no uncaught browser errors", errors.length === 0);
  console.log(`PASS ${results.length} native persistence checks`);
  if (process.env.ST_TEST_RESULTS) {
    await mkdir(path.dirname(process.env.ST_TEST_RESULTS), { recursive: true });
    await writeFile(
      process.env.ST_TEST_RESULTS,
      JSON.stringify({ results, errors, chatA, chatB }, null, 2),
      "utf8",
    );
  }
} finally {
  releaseSave?.();
  await browser.close();
}
