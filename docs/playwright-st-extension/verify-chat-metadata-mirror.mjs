// ticket 16 手动验收：真实 ST 中「镜像写入 → 文件持久化 → 设置开关 → LWW/未知版本守卫 → 清库恢复 → 按空间恢复」全流程。
/* global SillyTavern, $, document, indexedDB */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 说明：仅针对测试实例（tmp/SillyTavern_Source_Code）；启动时清测试角色对话文件残留、强制镜像设置默认开启。
// 用法：node verify-chat-metadata-mirror.mjs（exit 0 = 全流程通过）
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

/** 读页面内存里的绑定与镜像（getContext 每次构造新对象，直接读字段） */
async function readCurrentBindingAndMirror(page) {
  return page.evaluate(() => {
    const ctx = SillyTavern.getContext();
    return {
      chatId: ctx.chatId ?? null,
      binding: ctx.chatMetadata.steMemory ?? null,
      mirror: ctx.chatMetadata.steMemoryMirror ?? null,
    };
  });
}

/** 打开指定对话并轮询等待 chatId 就位 */
async function openChat(page, chatId) {
  await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, {
    timeout: 15000,
  });
  await page.evaluate(async (cid) => {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined) {
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
  );
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

/** 读对话文件首行 chat_metadata 里的镜像 */
function readFileMirror(chatFile) {
  if (!chatFile) return null;
  const headerLine = readFileSync(chatFile, "utf8").split("\n")[0];
  const header = JSON.parse(headerLine);
  return header.chat_metadata?.steMemoryMirror ?? null;
}

/** 打开面板 + 设置 Tab（等待镜像状态行出现） */
async function openSettingsTab(page) {
  await page.evaluate(() => {
    document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
  });
  await waitUntil(
    page,
    () => document.querySelector('#stm-panel .stm-tab[data-tab="settings"]') !== null,
    "面板渲染（设置 Tab 按钮）",
  );
  await page.evaluate(() => {
    document.querySelector('#stm-panel .stm-tab[data-tab="settings"]')?.click();
  });
  await waitUntil(
    page,
    () => document.querySelector('#stm-panel input[data-action="toggle-mirror"]') !== null,
    "设置 Tab 镜像组渲染",
  );
}

/** 面板内制造一次本地数据变更：切换第一张表的启停（指纹变化 → 触发镜像评估） */
async function toggleFirstTable(page) {
  await page.evaluate(() => {
    document.querySelector('#stm-panel .stm-tab[data-tab="tables"]')?.click();
  });
  await waitUntil(
    page,
    () => document.querySelector('#stm-panel input[data-action="toggle-table"]') !== null,
    "表格列表渲染",
  );
  await page.evaluate(() => {
    document.querySelector('#stm-panel input[data-action="toggle-table"]')?.click();
  });
}

/** 清空插件 Dexie 库的所有 store（等价「本地库被清」；不用 deleteDatabase——
 * 插件连接保持时 deleteDatabase 会被 blocked，请求随页面销毁丢弃） */
async function clearSteMemoryDb(page) {
  await page.evaluate(async () => {
    const open = indexedDB.open("ste-memory");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const stores = [...db.objectStoreNames];
    await new Promise((res, rej) => {
      const tx = db.transaction(stores, "readwrite");
      for (const store of stores) tx.objectStore(store).clear();
      tx.oncomplete = () => res(undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    db.close();
  });
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
    // 0. 加载插件 + 强制镜像设置为默认开启（settings.json 可能残留上次运行状态）
    await page.goto(ST_URL, { waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), 0, "插件初始化日志");
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      const key = "steMemory";
      const current = ctx.extensionSettings[key] ?? {};
      ctx.extensionSettings[key] = { ...current, enabled: true, mirror: { enabled: true, includeHistory: true } };
      ctx.saveSettingsDebounced();
    });
    await waitMs(2500); // saveSettingsDebounced（1s 防抖）落盘后再重启，否则写入丢失
    const logsBeforeReload = page.__steLogs.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), logsBeforeReload, "重启后插件初始化日志");

    // 1. 打开测试角色对话 → 自动建空间 + 绑定 + 镜像写回（空间创建即数据变更）
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 15000 });
    const logMark = page.__steLogs.length;
    await page.evaluate(async () => {
      await SillyTavern.getContext().selectCharacterById(0);
    });
    await waitForNewSteLog(page, (t) => t.includes("已为对话"), logMark, "首次建空间日志");
    const first = await readCurrentBindingAndMirror(page);
    const firstSpaceId = first.binding?.spaceId;
    check("绑定写入 chatMetadata", first.binding?.version === 1 && typeof firstSpaceId === "string", JSON.stringify(first.binding));

    // 镜像写回（轮询 2s + 防抖 3s + ST 保存）：等「已把记忆镜像写入对话文件」日志
    const writeMark = page.__steLogs.length;
    const writeLog = await waitForNewSteLog(
      page,
      (t) => t.includes("已把记忆镜像写入对话文件") && t.includes(firstSpaceId),
      writeMark,
      "首次镜像写回",
      20000,
    );
    await waitMs(2500); // saveMetadataDebounced（1s 防抖）+ 全量保存聊天文件
    const afterWrite = await readCurrentBindingAndMirror(page);
    const mirror = afterWrite.mirror;
    check(
      "镜像写入 chatMetadata：信封/spaceId/单元完整",
      mirror?.format === "ste-memory-chat-mirror"
        && mirror?.version === 1
        && mirror?.spaceId === firstSpaceId
        && mirror?.data?.space?.id === firstSpaceId
        && typeof mirror?.updatedAt === "string" && mirror.updatedAt.length > 0
        && Array.isArray(mirror?.data?.tables) && mirror.data.tables.length === 8,
      `${(writeLog.match(/（.+，([\d.]+) KB）/)?.[1] ?? "?")} KB`,
    );

    // 2. 镜像真实落在对话文件里（随文件走）
    const firstChatId = first.chatId;
    const chatFileA = findChatFile(ST_CHATS_ROOT, TEST_CHARACTER, firstChatId);
    const fileMirror = readFileMirror(chatFileA);
    check(
      "镜像持久化在对话文件 chatMetadata.steMemoryMirror",
      fileMirror?.spaceId === firstSpaceId && fileMirror?.version === 1,
      chatFileA ?? "对话文件不存在",
    );

    // 3. 设置面板镜像组：状态行展示「上次写回 … KB」+ 两个开关
    await openSettingsTab(page);
    const mirrorStatusText = await page.evaluate(
      () => document.querySelector('[data-stm-field="mirror-status"]')?.textContent ?? "",
    );
    check(
      "镜像状态行：上次写回 + 体积",
      mirrorStatusText.includes("上次写回") && mirrorStatusText.includes("KB"),
      mirrorStatusText,
    );
    const switches = await page.evaluate(() => ({
      mirror: document.querySelector('input[data-action="toggle-mirror"]')?.checked,
      history: document.querySelector('input[data-action="toggle-mirror-history"]')?.checked,
    }));
    check("镜像开关与修订历史开关默认开启", switches.mirror === true && switches.history === true, JSON.stringify(switches));

    // 4. 第二个对话：各自空间各自镜像（文件身份跟踪，互不干扰）
    const newChatMark = page.__steLogs.length;
    await page.evaluate(() => {
      $("#option_start_new_chat").trigger("click");
    });
    await page.waitForSelector("dialog.popup .popup-button-ok", { timeout: 5000 });
    await page.evaluate(() => {
      document.querySelector("dialog.popup .popup-button-ok")?.click();
    });
    await waitForNewSteLog(page, (t) => t.includes("已为对话"), newChatMark, "新对话建空间日志");
    await waitUntil(page, () => SillyTavern.getContext().chatId !== undefined, "新对话 chatId 就位");
    const second = await readCurrentBindingAndMirror(page);
    const secondSpaceId = second.binding?.spaceId;
    const secondChatId = second.chatId;
    const writeMarkB = page.__steLogs.length;
    await waitForNewSteLog(
      page,
      (t) => t.includes("已把记忆镜像写入对话文件") && t.includes(secondSpaceId),
      writeMarkB,
      "第二个对话镜像写回",
      20000,
    );
    await waitMs(2500);
    const chatFileB = findChatFile(ST_CHATS_ROOT, TEST_CHARACTER, secondChatId);
    check(
      "第二个对话：镜像独立写入自己的文件",
      readFileMirror(chatFileB)?.spaceId === secondSpaceId,
      chatFileB ?? "对话文件不存在",
    );

    // 5. LWW：文件镜像比本地新 → 不覆盖 + warn（改内存镜像 updatedAt 为未来时间，
    //    镜像写回判定读宿主内存值；磁盘文件不动，后续恢复测试不受影响）
    const warnMark = page.__steLogs.length;
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      if (ctx.chatMetadata.steMemoryMirror) {
        ctx.chatMetadata.steMemoryMirror.updatedAt = "2999-01-01T00:00:00.000Z";
      }
    });
    await toggleFirstTable(page);
    const lwwWarn = await waitForNewSteLog(
      page,
      (t) => t.includes("比本地数据新") && t.includes("未覆盖"),
      warnMark,
      "LWW warn 日志",
      20000,
    );
    const lwwState = await readCurrentBindingAndMirror(page);
    check(
      "LWW：镜像较新 → 不覆盖（updatedAt 保持未来值）",
      lwwState.mirror?.updatedAt === "2999-01-01T00:00:00.000Z",
      lwwWarn,
    );

    // 6. 无法识别的镜像（未来版本）→ 原样保留 + warn
    const unrecMark = page.__steLogs.length;
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      if (ctx.chatMetadata.steMemoryMirror) {
        ctx.chatMetadata.steMemoryMirror.version = 99;
      }
    });
    await toggleFirstTable(page);
    const unrecWarn = await waitForNewSteLog(
      page,
      (t) => t.includes("无法识别") && t.includes("已原样保留"),
      unrecMark,
      "无法识别 warn 日志",
      20000,
    );
    const unrecState = await readCurrentBindingAndMirror(page);
    check(
      "无法识别镜像：原样保留不覆盖（version 99 保持）",
      unrecState.mirror?.version === 99,
      unrecWarn,
    );

    // 7. 镜像总开关关闭 → 变更不再写回（磁盘镜像 updatedAt 不变）
    //    注意：面板此刻停在表格 Tab（step 5/6 切走），先切回设置 Tab 再点击
    const diskMirrorBefore = readFileMirror(chatFileB);
    await page.evaluate(() => {
      document.querySelector('#stm-panel .stm-tab[data-tab="settings"]')?.click();
    });
    await waitUntil(
      page,
      () => document.querySelector('input[data-action="toggle-mirror"]') !== null,
      "设置 Tab 镜像开关渲染",
    );
    await page.evaluate(() => {
      document.querySelector('input[data-action="toggle-mirror"]')?.click();
    });
    await waitMs(500);
    const offMark = page.__steLogs.length;
    await toggleFirstTable(page);
    await waitMs(8000); // 覆盖轮询 + 防抖窗口：若无写回则不应出现新写入日志
    const writesAfterOff = page.__steLogs.slice(offMark).filter((t) => t.includes("已把记忆镜像写入对话文件"));
    const diskMirrorAfter = readFileMirror(chatFileB);
    check(
      "镜像开关关闭：变更不写回（无新写入日志 + 磁盘镜像 unchanged）",
      writesAfterOff.length === 0 && diskMirrorAfter?.updatedAt === diskMirrorBefore?.updatedAt,
      `新写入日志=${writesAfterOff.length}`,
    );

    // 8. 镜像开关关闭时清库 → 打开对话不恢复（space-missing）；重新开启 → 恢复
    await clearSteMemoryDb(page);
    const reloadMark = page.__steLogs.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), reloadMark, "重启后插件初始化日志");
    await openChat(page, secondChatId);
    await waitMs(1500);
    const missingTitle = await page.evaluate(
      () => document.querySelector(".stm-space-title")?.textContent ?? "",
    );
    check(
      "开关关闭 + 清库：空间缺失且不恢复",
      missingTitle.includes("数据未就绪"),
      missingTitle,
    );
    const dbGated = await readSteMemoryDb(page);
    check("开关关闭：清库后无空间被恢复", dbGated.spaces.length === 0, JSON.stringify(dbGated.spaces));

    // 重新开启镜像 → 重启 → 打开对话 → 从镜像恢复
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      const current = ctx.extensionSettings.steMemory ?? {};
      ctx.extensionSettings.steMemory = { ...current, mirror: { enabled: true, includeHistory: true } };
      ctx.saveSettingsDebounced();
    });
    await waitMs(2500); // 防抖保存落盘
    const reloadMark2 = page.__steLogs.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), reloadMark2, "重启后插件初始化日志");
    // restored 标记只属于恢复那一次同步，且 openChat 触发的后续同步会覆盖它——
    // 用 MutationObserver 在 DOM 更新瞬间记录「已从文件镜像恢复」是否出现过
    await page.evaluate(() => {
      window.__restoredSeen = false;
      new MutationObserver(() => {
        if (document.querySelector(".stm-space-status")?.textContent.includes("已从文件镜像恢复")) {
          window.__restoredSeen = true;
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await openChat(page, secondChatId);
    const restoreLog = await waitForNewSteLog(
      page,
      (t) => t.includes("已从对话文件镜像恢复") && t.includes(secondSpaceId),
      reloadMark2,
      "镜像恢复日志",
      20000,
    );
    await waitMs(1500); // 等标记渲染（可能随后被二次同步覆盖，observer 已记录）
    const restoredSeen = await page.evaluate(() => window.__restoredSeen === true);
    check(
      "重新开启后：从文件镜像恢复（头部出现过恢复标记）",
      restoredSeen,
      restoreLog,
    );
    const dbRestored = await readSteMemoryDb(page);
    check(
      "恢复落地：空间 + 8 张系统表就位",
      dbRestored.spaces.length === 1 && dbRestored.tablesPerSpace === 8,
      JSON.stringify(dbRestored.spaces),
    );

    // 9. 按空间恢复：清库后先开对话 A 只恢复 A，再开 B 恢复 B（互不误伤）
    //    上一段停在对话 B；先切到 A 让重启后的自动打开落在 A
    await openChat(page, firstChatId);
    await waitMs(1000);
    await clearSteMemoryDb(page);
    const reloadMark3 = page.__steLogs.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), reloadMark3, "重启后插件初始化日志");
    await page.evaluate(() => {
      window.__restoredSeen = false;
      new MutationObserver(() => {
        if (document.querySelector(".stm-space-status")?.textContent.includes("已从文件镜像恢复")) {
          window.__restoredSeen = true;
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await openChat(page, firstChatId);
    await waitForNewSteLog(
      page,
      (t) => t.includes("已从对话文件镜像恢复") && t.includes(firstSpaceId),
      reloadMark3,
      "对话 A 镜像恢复日志",
      20000,
    );
    await waitMs(1500);
    const restoredSeenA = await page.evaluate(() => window.__restoredSeen === true);
    check("恢复 A：头部出现过「已从文件镜像恢复」标记", restoredSeenA, "MutationObserver 记录");
    const dbAfterA = await readSteMemoryDb(page);
    check("恢复 A：只有 A 的空间（B 不受影响）", dbAfterA.spaces.length === 1 && dbAfterA.spaces[0]?.id === firstSpaceId, JSON.stringify(dbAfterA.spaces));

    const markB = page.__steLogs.length;
    await openChat(page, secondChatId);
    await waitForNewSteLog(
      page,
      (t) => t.includes("已从对话文件镜像恢复") && t.includes(secondSpaceId),
      markB,
      "对话 B 镜像恢复日志",
      20000,
    );
    const dbAfterB = await readSteMemoryDb(page);
    check("恢复 B：A、B 两个空间并存", dbAfterB.spaces.length === 2, JSON.stringify(dbAfterB.spaces.map((s) => s.id)));

    // 10. 全程无插件相关页面错误 + 现场恢复设置默认
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      const current = ctx.extensionSettings.steMemory ?? {};
      ctx.extensionSettings.steMemory = { ...current, mirror: { enabled: true, includeHistory: true } };
      ctx.saveSettingsDebounced();
    });
    await waitMs(2500); // 防抖保存落盘（避免残留关闭态影响下次运行）
    const mirrorErrors = pageErrors.filter((e) => e.toLowerCase().includes("ste-memory"));
    check("全程无 ste-memory 相关页面错误", mirrorErrors.length === 0, mirrorErrors.join(" | ") || "无");

    const shotPath = path.join(process.env.TMPDIR ?? "/tmp", `ste-memory-mirror-acceptance-${Date.now()}.png`);
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
