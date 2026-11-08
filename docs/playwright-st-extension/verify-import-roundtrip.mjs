// Writes test chats: run only against an isolated ST data root with ST_IMPORT_TEST_INSTANCE=1.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";
import { createBackupFile, decodeBackupFile } from "../../src/features/backup/backup-codec.ts";
import { migrateMemorySpaceSnapshot } from "../../src/features/memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../../src/features/memory-snapshot/snapshot-test-fixture.ts";

assert.ok(
  process.env.ST_URL && process.env.ST_IMPORT_TEST_INSTANCE === "1",
  "Specify an isolated ST_URL and ST_IMPORT_TEST_INSTANCE=1",
);
const source = process.env.IMPORT_BACKUP
  ? decodeBackupFile(JSON.parse(await readFile(process.env.IMPORT_BACKUP, "utf8"))).data.spaces[0]
  : migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacySnapshotFixture() });
if (!process.env.IMPORT_BACKUP) {
  source.history[0].payload.archived_unknown = "opaque historical value";
}
const buffer = Buffer.from(
  JSON.stringify(
    createBackupFile({ spaces: [source] }, "import-validation", new Date().toISOString()),
  ),
);
const results = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-proxy-server"],
});
const width = Number(process.env.ST_TEST_WIDTH ?? 1440);
const page = await browser.newPage({ viewport: { width, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const writes = [];
page.on("request", (request) => {
  if (/\/api\/chats\/(?:group\/)?save$/.test(request.url())) {
    writes.push(request.url());
  }
});
const panel = page.locator("#ste-memory-app");
const button = (name) => panel.getByRole("button", { name, exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  results.push(name);
  console.log(`PASS ${name}`);
};
const snapshot = () =>
  page.evaluate(() => window.__STE_MEMORY_RUNTIME__.backup.exportCurrentSpace());
async function ready() {
  await page.waitForFunction(
    () => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      const target = runtime?.adapter.captureFileTarget();
      return (
        runtime?.manager.getStatus()?.kind === "active" &&
        target &&
        ["idle", "verified"].includes(runtime.persistence.getStatus(target.identity).kind)
      );
    },
    null,
    { timeout: 45000 },
  );
}
async function maintenance() {
  if (!(await panel.isVisible())) {
    await page.locator('[data-action="open-frontend"]').first().click();
  }
  await panel.locator('[data-action="nav-settings"]').click();
  await button("备份与空间维护").click();
}
async function upload(content = buffer, confirmed = true) {
  const oldId = await page.evaluate(() => {
    const status = window.__STE_MEMORY_RUNTIME__.manager.getStatus();
    return status?.kind === "active" ? status.space.id : null;
  });
  await panel.getByLabel("选择备份 JSON", { exact: true }).setInputFiles({
    name: "import-validation.json",
    mimeType: "application/json",
    buffer: content,
  });
  await panel.getByTestId("backup-preview").waitFor();
  await button("确认导入此文件").click();
  await page.getByRole("button", { name: "执行导入", exact: true }).click();
  if (confirmed) {
    await page.waitForFunction(
      (oldId) => {
        const runtime = window.__STE_MEMORY_RUNTIME__;
        return (
          runtime.manager.getStatus()?.space?.id !== oldId &&
          runtime.persistence.getStatus(runtime.adapter.captureFileTarget()?.identity).kind ===
            "verified"
        );
      },
      oldId,
      { timeout: 45000 },
    );
  }
}
async function reloadChat(loaded = true) {
  const target = await page.evaluate(() => ({
    ...window.__STE_MEMORY_RUNTIME__.adapter.captureFileTarget(),
    groupId: SillyTavern.getContext().groupId,
  }));
  await page.reload();
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await page.locator("#preloader").waitFor({ state: "hidden" });
  if (target.kind === "group") {
    await page.waitForFunction(
      (id) => SillyTavern.getContext().groups.some((group) => group.id === id),
      target.groupId,
    );
  }
  await page.evaluate(async (target) => {
    const context = SillyTavern.getContext();
    if (target.kind === "character") {
      await context.selectCharacterById(
        context.characters.findIndex((character) => character.avatar === target.avatarUrl),
      );
      await SillyTavern.getContext().openCharacterChat(target.chatId);
    } else {
      const groups = await import("/scripts/group-chats.js");
      if (SillyTavern.getContext().groupId !== target.groupId) {
        await groups.openGroupById(target.groupId);
      }
      await SillyTavern.getContext().openGroupChat(target.groupId, target.chatId);
    }
  }, target);
  if (loaded) {
    await ready();
  } else {
    await page.waitForFunction(
      () => window.__STE_MEMORY_RUNTIME__.manager.getStatus()?.kind === "load-error",
    );
  }
}
async function persisted(label) {
  await ready();
  const current = await snapshot();
  check(
    `${label}: all records and history loaded`,
    current.records.length === source.records.length &&
      current.history.length === source.history.length,
  );
  if (!process.env.IMPORT_BACKUP) {
    check(
      `${label}: deleted-field archive retained`,
      current.history[0].payload.archived_unknown === "opaque historical value",
    );
  }
  const metadata = await page.evaluate(async () => {
    const runtime = window.__STE_MEMORY_RUNTIME__;
    const target = runtime.adapter.captureFileTarget();
    return runtime.adapter.snapshotFileStore.verify(target);
  });
  assert.deepEqual(metadata.steMemoryMirror.data, JSON.parse(JSON.stringify(current)));
  check(`${label}: native ST file equals complete SQLite export`, true);
  return current;
}
try {
  await page.goto(process.env.ST_URL);
  await page.waitForFunction(
    () => window.__STE_MEMORY_RUNTIME__ && SillyTavern.getContext().characters.length,
  );
  await page.locator("#preloader").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const context = SillyTavern.getContext();
    await context.selectCharacterById(0);
    await SillyTavern.getContext().openCharacterChat(`ste-import-${Date.now()}`);
  });
  await ready();
  await maintenance();
  await upload();
  const first = await persisted("character import");
  await panel.getByRole("alert").filter({ hasText: "当前对话的记忆空间已替换。" }).waitFor();
  await upload();
  const second = await persisted("repeat import");
  check(
    "repeat import creates independent ID and keeps stable lineage",
    first.space.id !== second.space.id && first.space.stableId === second.space.stableId,
  );

  const beforeFailure = await snapshot();
  await panel.getByLabel("选择备份 JSON", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("invalid JSON"),
  });
  await button("查看本次导入日志").last().waitFor();
  check(
    "invalid file keeps current memory",
    (await snapshot()).space.id === beforeFailure.space.id,
  );
  await button("查看本次导入日志").last().click();
  check("failure opens related import log", (await panel.innerText()).includes("memory-import"));
  await reloadChat();
  check("reload restores the confirmed space", (await snapshot()).space.id === second.space.id);
  await persisted("character reload");

  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const response = await fetch("/api/groups/create", {
      method: "POST",
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({
        name: `ste-import-group-${Date.now()}`,
        members: [ctx.characters[0].avatar],
      }),
    });
    if (!response.ok) {
      throw new Error(`create group failed ${response.status}`);
    }
    const group = await response.json();
    ctx.groups.push(group);
    const groups = await import("/scripts/group-chats.js");
    if (!(await groups.openGroupById(group.id))) {
      throw new Error("group did not open");
    }
  });
  await ready();
  await maintenance();
  await upload();
  await persisted("group import");
  let rejected = false;
  await page.route("**/api/chats/group/get", (route) => {
    if (!rejected) {
      rejected = true;
      return route.fulfill({ status: 503, body: "test verification unavailable" });
    }
    return route.continue();
  });
  await upload(buffer, false);
  await page.waitForFunction(
    () =>
      window.__STE_MEMORY_RUNTIME__.persistence.getStatus(
        window.__STE_MEMORY_RUNTIME__.adapter.captureFileTarget().identity,
      ).kind === "failed",
  );
  const candidate = await snapshot();
  await page
    .getByTestId("snapshot-save-notice")
    .getByRole("button", { name: "重试保存", exact: true })
    .click();
  await ready();
  check(
    "verification retry keeps the imported ID",
    (await snapshot()).space.id === candidate.space.id,
  );
  await page.unroute("**/api/chats/group/get");
  await persisted("verification retry");
  await page.evaluate(() => {
    const store = window.__STE_MEMORY_RUNTIME__.queryChat.store;
    const original = store.clearSpaceHistory;
    let failed = false;
    store.clearSpaceHistory = async function (...args) {
      if (!failed) {
        failed = true;
        throw new Error("test old Agent history cleanup failed");
      }
      return original.apply(this, args);
    };
    window.__restoreImportCleanup = () => {
      store.clearSpaceHistory = original;
    };
  });
  await upload();
  await page
    .getByTestId("snapshot-save-notice")
    .getByRole("button", { name: "重试清理", exact: true })
    .waitFor();
  const savedCount = writes.length;
  await page
    .getByTestId("snapshot-save-notice")
    .getByRole("button", { name: "重试清理", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !window.__STE_MEMORY_RUNTIME__.persistence.hasPendingCleanup(
        window.__STE_MEMORY_RUNTIME__.adapter.captureFileTarget().identity,
      ),
  );
  check("cleanup retry does not upload chat", writes.length === savedCount);
  await page.evaluate(() => window.__restoreImportCleanup());
  const group = await persisted("cleanup retry");
  await reloadChat();
  check(
    "group reload restores the confirmed space",
    (await snapshot()).space.id === group.space.id,
  );
  await persisted("group reload");
  await page.evaluate(async () => {
    const context = SillyTavern.getContext();
    context.chatMetadata.steMemoryMirror = { invalid: true };
    await context.saveMetadata();
  });
  await reloadChat(false);
  await maintenance();
  check("broken-space recovery keeps export disabled", await button("导出 JSON 文件").isDisabled());
  await upload();
  await persisted("broken-space recovery");
  check(
    "no horizontal overflow",
    await page.evaluate(() => {
      const panel = document.querySelector("#ste-memory-app");
      return panel.scrollWidth <= panel.clientWidth + 1;
    }),
  );
  check("native saves were exercised", writes.length >= 5);
  check("no uncaught browser errors", errors.length === 0);
  if (process.env.IMPORT_RESULTS) {
    await mkdir(dirname(process.env.IMPORT_RESULTS), { recursive: true });
    await writeFile(
      process.env.IMPORT_RESULTS,
      JSON.stringify({ results, nativeSaveRequests: writes.length, errors }, null, 2),
      "utf8",
    );
  }
} catch (error) {
  console.error(
    await page.evaluate(() => ({
      state: window.__STE_MEMORY_RUNTIME__?.manager.getStatus()?.kind,
      save: window.__STE_MEMORY_RUNTIME__?.persistence.getStatus(
        window.__STE_MEMORY_RUNTIME__?.adapter.captureFileTarget()?.identity,
      ),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
    })),
  );
  throw error;
} finally {
  await browser.close();
}
