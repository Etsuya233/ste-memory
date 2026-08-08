// ticket 05 手动验收：真实 ST 中「打开对话建空间 → 发消息 → 切对话 → 重命名 → 刷新不重建」全流程。
/* global SillyTavern, $, document, indexedDB */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 说明：仅针对测试实例（tmp/SillyTavern_Source_Code）；启动时会清掉测试角色的对话文件残留。
// 用法：node verify-space-binding.mjs（exit 0 = 全流程通过）
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";
const ST_CHATS_ROOT = process.env.STE_ST_DATA
  ?? "/home/etsuya/programming/ste-memory/tmp/SillyTavern_Source_Code/data/default-user/chats";
const TEST_CHARACTER = "Seraphina";

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cache = path.join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) throw new Error("未找到 playwright chromium 缓存");
  const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium-"));
  if (dirs.length === 0) throw new Error("playwright chromium 缓存为空");
  const latest = dirs.sort().at(-1);
  const candidates = [
    path.join(cache, latest, "chrome-linux64/chrome"),
    path.join(cache, latest, "chrome-linux/chrome"),
    path.join(cache, latest, "chrome-linux/chrome-headless-shell"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`chromium 可执行文件缺失：${candidates.join(" / ")}`);
  return found;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function waitMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** 等待出现「第 since 条之后的」新 STE Memory 日志（避免匹配到历史日志） */
async function waitForNewSteLog(page, matcher, since, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = page.__steLogs.slice(since).find((t) => matcher(t));
    if (found) return found;
    await waitMs(250);
  }
  throw new Error(`等待 STE Memory 日志超时：${label}（日志总数=${page.__steLogs.length}）`);
}

/** 轮询直到 evaluate 谓词为真（谓词参数经 args 传入页面上下文） */
async function waitUntil(page, predicate, label, timeoutMs = 20000, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return;
    await waitMs(300);
  }
  throw new Error(`等待条件超时：${label}`);
}

/** 读插件 Dexie 库（ste-memory）的空间/表计数（原始 indexedDB，不依赖 Dexie 全局） */
async function readSteMemoryDb(page) {
  return page.evaluate(async () => {
    const open = indexedDB.open("ste-memory");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const all = (store) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    const [spaces, tables] = await Promise.all([all("memorySpaces"), all("memoryTables")]);
    db.close();
    return {
      spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
      tablesPerSpace: tables.length,
    };
  });
}

async function readCurrentBinding(page) {
  return page.evaluate(() => {
    const ctx = SillyTavern.getContext();
    return { chatId: ctx.chatId ?? null, binding: ctx.chatMetadata.steMemory ?? null };
  });
}

/** 打开指定对话并轮询等待 chatId 就位（ST 内部保存未完成时会等待，单次调用 + 轮询即可） */
async function openChat(page, chatId) {
  await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, {
    timeout: 15000,
  });
  await page.evaluate(async (cid) => {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined) {
      // 刷新后未选角色：先选中测试角色
      const idx = ctx.characters.findIndex((c) => c.name === "Seraphina");
      if (idx >= 0) await ctx.selectCharacterById(idx);
    }
    await ctx.openCharacterChat(cid);
  }, chatId);
  await waitUntil(
    page,
    (cid) => SillyTavern.getContext().chatId === cid,
    `打开对话 ${chatId}`,
    20000,
    chatId,
  ).catch(async (error) => {
    const state = await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      return {
        chatId: ctx.chatId,
        characterId: ctx.characterId,
        groupId: ctx.groupId,
        chatLen: ctx.chat.length,
      };
    });
    throw new Error(`${error.message}（当前状态：${JSON.stringify(state)}）`);
  });
}

/** 在角色聊天目录（形如 chats/default_Seraphina/）里找对话文件 */
function findChatFile(chatsRoot, characterName, chatId) {
  if (!existsSync(chatsRoot)) return null;
  for (const dir of readdirSync(chatsRoot)) {
    if (!dir.includes(characterName)) continue;
    const candidate = path.join(chatsRoot, dir, `${chatId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  // 清掉测试残留对话文件（仅测试实例；角色目录名形如 chats/default_Seraphina/）
  if (existsSync(ST_CHATS_ROOT)) {
    for (const dir of readdirSync(ST_CHATS_ROOT)) {
      if (!dir.includes(TEST_CHARACTER)) continue;
      for (const file of readdirSync(path.join(ST_CHATS_ROOT, dir))) {
        rmSync(path.join(ST_CHATS_ROOT, dir, file));
      }
    }
  }

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-proxy-server"],
    env: {
      ...process.env,
      HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "",
      ALL_PROXY: "", all_proxy: "",
    },
  });
  const page = await browser.newPage();
  page.__steLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[STE Memory]")) page.__steLogs.push(text);
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    // 1. 加载插件
    await page.goto(ST_URL, { waitUntil: "domcontentloaded" });
    const initText = await waitForNewSteLog(page, (t) => t.includes("已加载"), 0, "插件初始化日志");
    check("插件加载：初始化日志", initText.includes("v0.1.0"), initText);

    // 2. 打开测试角色的对话 → 自动建空间 + 写绑定 + 系统表就位
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 15000 });
    const logCountBeforeOpen = page.__steLogs.length;
    await page.evaluate(async () => {
      await SillyTavern.getContext().selectCharacterById(0);
    });
    const createdText = await waitForNewSteLog(page, (t) => t.includes("已为对话"), logCountBeforeOpen, "首次建空间日志");
    check(
      "首次打开对话：自动创建记忆空间",
      /已为对话「.+」创建记忆空间「.+」（.+）/.test(createdText),
      createdText,
    );

    const first = await readCurrentBinding(page);
    check(
      "绑定写入 chatMetadata（steMemory 指针）",
      first.binding?.version === 1 && typeof first.binding.spaceId === "string",
      JSON.stringify(first.binding),
    );
    const db1 = await readSteMemoryDb(page);
    check("系统表就位（8 张，含世界状态表）", db1.tablesPerSpace === 8, `tables=${db1.tablesPerSpace}`);
    check("仅一个记忆空间", db1.spaces.length === 1, JSON.stringify(db1.spaces.map((s) => s.name)));
    const firstSpaceId = first.binding.spaceId;
    const firstChatId = first.chatId;
    const firstSpaceName = db1.spaces[0]?.name;

    // 3. 发消息（MESSAGE_SENT / MESSAGE_RECEIVED 已注册；无 LLM 后端，生成失败可接受）
    await page.evaluate(() => {
      $("#send_textarea").val("这是一条测试消息，用于验证消息事件桥。").trigger("input");
      $("#send_but").trigger("click");
    });
    await waitMs(2500);
    const bridgeErrors = pageErrors.filter((e) => e.toLowerCase().includes("ste-memory"));
    check(
      "发消息：事件桥已注册且不抛错",
      bridgeErrors.length === 0,
      bridgeErrors.join(" | ") || "无 ste-memory 相关错误",
    );

    // 4. 新对话 → 第二个空间；切回原对话 → 绑定不变
    await page.evaluate(() => {
      $("#option_start_new_chat").trigger("click");
    });
    await page.waitForSelector("dialog.popup .popup-button-ok", { timeout: 5000 });
    await page.evaluate(() => {
      document.querySelector("dialog.popup .popup-button-ok")?.click();
    });
    const logCountBeforeNewChat = page.__steLogs.length;
    await waitForNewSteLog(page, (t) => t.includes("已为对话"), logCountBeforeNewChat, "新对话建空间日志");
    await waitUntil(
      page,
      () => SillyTavern.getContext().chatId !== undefined,
      "新对话 chatId 就位",
    );
    const db2 = await readSteMemoryDb(page);
    check("新建对话：自动创建第二个空间", db2.spaces.length === 2, `spaces=${db2.spaces.length}`);

    await openChat(page, firstChatId);
    const back = await readCurrentBinding(page);
    check("切回原对话：绑定指向原空间", back.binding?.spaceId === firstSpaceId, `spaceId=${back.binding?.spaceId}`);
    const db3 = await readSteMemoryDb(page);
    check("切回不重复建空间", db3.spaces.length === 2, `spaces=${db3.spaces.length}`);

    // 5. 重命名对话 → 绑定跟随（chatMetadata 在文件内），空间显示名保持
    const renamedChatId = `${firstChatId}-已改名`;
    await page.evaluate(async ({ oldName, newName }) => {
      await SillyTavern.getContext().renameChat(oldName, newName);
    }, { oldName: firstChatId, newName: renamedChatId });
    await waitUntil(
      page,
      (cid) => SillyTavern.getContext().chatId === cid,
      "重命名后 chatId 更新",
      20000,
      renamedChatId,
    );
    await waitMs(2500); // saveMetadataDebounced（1s 防抖）+ 落盘
    const renamed = await readCurrentBinding(page);
    check(
      "重命名后绑定不丢（同 spaceId）",
      renamed.binding?.spaceId === firstSpaceId && renamed.chatId === renamedChatId,
      `chatId=${renamed.chatId}`,
    );
    const db4 = await readSteMemoryDb(page);
    const renamedSpace = db4.spaces.find((s) => s.id === firstSpaceId);
    check(
      "空间显示名保持创建时值",
      renamedSpace?.name === firstSpaceName,
      `${renamedSpace?.name}（原名 ${firstSpaceName}）`,
    );

    // 6. 绑定真实落在对话文件里（随文件走）
    const chatFile = findChatFile(ST_CHATS_ROOT, TEST_CHARACTER, renamedChatId);
    let fileBinding = null;
    if (chatFile) {
      const headerLine = readFileSync(chatFile, "utf8").split("\n")[0];
      const header = JSON.parse(headerLine);
      fileBinding = header.chat_metadata?.steMemory ?? null;
    }
    check(
      "绑定持久化在对话文件 chatMetadata 中",
      fileBinding?.spaceId === firstSpaceId,
      chatFile ?? "对话文件不存在",
    );

    // 7. 刷新页面 → 再次打开同一对话不重复建
    const logsBeforeReload = page.__steLogs.length;
    pageErrors.length = 0;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), logsBeforeReload, "刷新后插件初始化日志");
    await openChat(page, renamedChatId);
    await waitMs(1500);
    const db5 = await readSteMemoryDb(page);
    const refreshedBinding = await readCurrentBinding(page);
    const newCreationLogs = page.__steLogs
      .slice(logsBeforeReload)
      .filter((t) => t.includes("已为对话"));
    check(
      "刷新后再次打开：不重复建空间",
      db5.spaces.length === 2 && newCreationLogs.length === 0,
      `spaces=${db5.spaces.length}，新建日志=${JSON.stringify(newCreationLogs)}`,
    );
    check("刷新后绑定指向原空间", refreshedBinding.binding?.spaceId === firstSpaceId);

    // 截图留证
    const shotPath = path.join(process.env.TMPDIR ?? "/tmp", `ste-memory-acceptance-${Date.now()}.png`);
    await page.screenshot({ path: shotPath });
    console.log(`截图：${shotPath}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项未通过`);
    process.exit(1);
  }
  console.log(`\n全部 ${results.length} 项通过`);
}

main().catch((error) => {
  console.error("验收脚本失败：", error);
  process.exit(1);
});
