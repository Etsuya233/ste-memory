// ticket 06 手动验收：真实 ST 中「顶部按钮 → 面板骨架（移动抽屉/桌面浮动）→ 表格列表启停落库
// → 设置面板持久化与插件开关」全流程。
/* global SillyTavern, document, indexedDB, window, toastr, getComputedStyle */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 用法：node verify-ui-shell.mjs（exit 0 = 全流程通过）
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";
const TEST_CHARACTER = "Seraphina";
const ST_CHATS_ROOT = process.env.STE_ST_DATA
  ?? "/home/etsuya/programming/ste-memory/tmp/SillyTavern_Source_Code/data/default-user/chats";

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cache = path.join(osHomedir(), ".cache/ms-playwright");
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

/** 读插件 Dexie 库：空间 + 表格（含 enabled）+ 字段（含 enabled） */
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
    const [spaces, tables, fields] = await Promise.all([
      all("memorySpaces"),
      all("memoryTables"),
      all("memoryFields"),
    ]);
    db.close();
    return {
      spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
      tables: tables.map((t) => ({ id: t.id, key: t.key, enabled: t.enabled })),
      fields: fields.map((f) => ({ id: f.id, key: f.key, enabled: f.enabled })),
    };
  });
}

async function waitForDbState(page, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await readSteMemoryDb(page))) return;
    await waitMs(300);
  }
  throw new Error(`等待数据库状态超时：${label}`);
}

async function main() {
  // 清掉测试角色对话文件残留（含上次验收的绑定指针）→ 强制全新建空间路径
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // 移动端优先：先按手机宽度验收
  page.__steLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[STE Memory]")) page.__steLogs.push(text);
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[STE Memory]")) pageErrors.push(msg.text());
  });

  try {
    // 1. 加载插件（移动端视口）
    await page.goto(ST_URL, { waitUntil: "domcontentloaded" });
    const initText = await waitForNewSteLog(page, (t) => t.includes("已加载"), 0, "插件初始化日志");
    check("插件加载：初始化日志", initText.includes("v0.1.0"), initText);

    // 2. 打开测试角色对话 → 自动建空间（面板表格列表的数据前提）
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 15000 });
    const logCountBeforeOpen = page.__steLogs.length;
    await page.evaluate(async (characterName) => {
      const ctx = SillyTavern.getContext();
      const idx = ctx.characters.findIndex((c) => c.name === characterName);
      await ctx.selectCharacterById(idx >= 0 ? idx : 0);
    }, TEST_CHARACTER);
    await waitForNewSteLog(page, (t) => t.includes("已为对话"), logCountBeforeOpen, "首次建空间日志");
    await waitUntil(page, () => SillyTavern.getContext().chatId !== undefined, "对话 chatId 就位");
    const db0 = await readSteMemoryDb(page);
    check("前置：对话自动建空间", db0.spaces.length >= 1, `spaces=${db0.spaces.length}`);
    const spaceName = db0.spaces[0]?.name;

    // 3. 顶部按钮存在并呼出面板（移动端底部抽屉）
    const buttonInfo = await page.evaluate(() => {
      const button = document.querySelector("#top-settings-holder .stm-toolbar-button");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { pressed: button.getAttribute("aria-pressed"), rect: { w: rect.width, h: rect.height } };
    });
    check(
      "顶部工具栏按钮就位（#top-settings-holder 内，填满顶栏高度）",
      buttonInfo !== null && buttonInfo.rect.h >= 30,
      JSON.stringify(buttonInfo?.rect),
    );

    await page.evaluate(() => {
      document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
    });
    await waitUntil(
      page,
      () => {
        const panel = document.getElementById("stm-panel");
        return panel?.classList.contains("stm-panel--open") && panel.getAttribute("aria-hidden") === "false";
      },
      "面板打开",
    );
    await waitMs(400); // 等抽屉开合动画结束再量绘制位置（0.22s 过渡）

    // 移动端抽屉布局断言（computed style + 实际绘制位置——防 fixed 包含块类 bug）
    const mobileStyle = await page.evaluate(() => {
      const panel = document.getElementById("stm-panel");
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return {
        position: style.position,
        bottom: style.bottom,
        left: style.left,
        height: style.height,
        radius: style.borderRadius,
        rect: {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        },
        innerHeight: window.innerHeight,
      };
    });
    check(
      "移动端（390px）：全屏底部抽屉且覆盖整个视口",
      mobileStyle.position === "fixed" &&
        mobileStyle.left === "0px" &&
        mobileStyle.rect.top <= 0 &&
        mobileStyle.rect.bottom >= mobileStyle.innerHeight &&
        parseFloat(mobileStyle.height) > 500,
      JSON.stringify(mobileStyle),
    );

    // 4. 面板骨架：空间信息 + 底部 Tab 四枚 + 表格列表（系统表启停）
    const skeleton = await page.evaluate(() => {
      const panel = document.getElementById("stm-panel");
      const title = panel.querySelector(".stm-space-title")?.textContent ?? "";
      const tabs = [...panel.querySelectorAll(".stm-tab")].map((t) => t.textContent.trim());
      // React 条件渲染：DOM 中只存在激活区块，存在即激活
      const activeSection = panel.querySelector(".stm-tab-section")?.dataset.stmSection;
      return { title, tabs, activeSection, tableCards: panel.querySelectorAll(".stm-table-card").length };
    });
    check(
      "面板显示当前空间名称",
      skeleton.title === spaceName,
      `${skeleton.title}（期望 ${spaceName}）`,
    );
    check(
      "底部 Tab：表格/记录/任务/设置",
      JSON.stringify(skeleton.tabs) === JSON.stringify(["表格", "记录", "任务", "设置"]),
      JSON.stringify(skeleton.tabs),
    );
    check("默认激活表格 Tab", skeleton.activeSection === "tables");
    check(
      "表格列表渲染 8 张系统表",
      skeleton.tableCards === 8,
      `cards=${skeleton.tableCards}`,
    );

    // 首个表格自动展开：字段行可见
    const firstFields = await page.evaluate(() => {
      const rows = document.querySelectorAll("#stm-panel .stm-field-row");
      return [...rows].map((r) => r.querySelector(".stm-field-name")?.textContent ?? "");
    });
    check("首个表格默认展开字段", firstFields.length > 0, `fields=${firstFields.length}`);

    // 优化项 2：点击表格行（开关/展开按钮之外）可展开/收起字段
    await page.evaluate(() => {
      document.querySelectorAll("#stm-panel .stm-table-card")[1].querySelector(".stm-table-row-main").click();
    });
    await waitMs(400);
    const rowExpandState = await page.evaluate(() => {
      const card = document.querySelectorAll("#stm-panel .stm-table-card")[1];
      return { expanded: card.querySelector(".stm-field-list") !== null, ariaExpanded: card.querySelector(".stm-expand")?.getAttribute("aria-expanded") };
    });
    check(
      "点击表格行（非开关区域）展开字段",
      rowExpandState.expanded === true && rowExpandState.ariaExpanded === "true",
      JSON.stringify(rowExpandState),
    );
    await page.evaluate(() => {
      document.querySelectorAll("#stm-panel .stm-table-card")[1].querySelector(".stm-table-row-main").click();
    });
    await waitMs(400);
    const rowCollapseState = await page.evaluate(() => {
      const card = document.querySelectorAll("#stm-panel .stm-table-card")[1];
      return { collapsed: card.querySelector(".stm-field-list") === null, ariaExpanded: card.querySelector(".stm-expand")?.getAttribute("aria-expanded") };
    });
    check(
      "再次点击表格行收起字段",
      rowCollapseState.collapsed === true && rowCollapseState.ariaExpanded === "false",
      JSON.stringify(rowCollapseState),
    );

    // 5. 表格启停落库：停用第一个表格 → Dexie enabled=false + UI 反映
    const firstTableId = await page.evaluate(
      () => document.querySelector('#stm-panel input[data-action="toggle-table"]')?.dataset.tableId,
    );
    await page.evaluate(() => {
      document.querySelector('#stm-panel input[data-action="toggle-table"]')?.click();
    });
    await waitForDbState(
      page,
      (db) => db.tables.find((t) => t.id === firstTableId)?.enabled === false,
      "表格停用落库",
    );
    const tableRowState = await page.evaluate(() => {
      const row = document.querySelector('#stm-panel input[data-action="toggle-table"]');
      return row?.checked;
    });
    check("表格停用：Dexie 落库 + UI 开关反映", tableRowState === false);

    // 6. 字段启停落库：第一个字段（显示策略依赖，ticket 10 UI 前置禁用）与第二个字段（正常落库）
    // 系统表显示策略引用第一个字段（模板 fields[0]）；UI 对依赖字段禁用启停开关（
    // core memory_field_used_by_display_strategy 仍作为编程路径兜底，见单元测试）
    const dependentToggleDisabled = await page.evaluate(
      () =>
        document.querySelectorAll('#stm-panel input[data-action="toggle-field"]')[0]?.disabled ??
        null,
    );
    check(
      "停用显示策略依赖字段：开关被禁用（UI 前置保护，不落库）",
      dependentToggleDisabled === true,
      `disabled=${dependentToggleDisabled}`,
    );

    const firstFieldId = await page.evaluate(
      () => document.querySelectorAll('#stm-panel input[data-action="toggle-field"]')[1]?.dataset.fieldId,
    );
    await page.evaluate(() => {
      document.querySelectorAll('#stm-panel input[data-action="toggle-field"]')[1]?.click();
    });
    await waitForDbState(
      page,
      (db) => db.fields.find((f) => f.id === firstFieldId)?.enabled === false,
      "字段停用落库",
    );
    check("字段停用：Dexie 落库", true);
    // 恢复现场：表格与字段重新启用
    await page.evaluate(() => {
      document.querySelectorAll('#stm-panel input[data-action="toggle-table"], #stm-panel input[data-action="toggle-field"]')
        .forEach((input) => { if (!input.checked) input.click(); });
    });
    await waitForDbState(
      page,
      (db) => db.tables.every((t) => t.enabled) && db.fields.every((f) => f.enabled),
      "现场恢复：表格与字段重新启用",
    );

    // 7. 记录/任务 Tab：记录视图（ticket 11 替换占位）；设置 Tab 内容与插件开关持久化
    await page.evaluate(() => {
      document.querySelector('#stm-panel .stm-tab[data-tab="records"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel select[data-action="record-table-select"]'),
      "记录 Tab 表选择器就位",
    );
    const recordsTab = await page.evaluate(() => {
      const section = document.querySelector('#stm-panel [data-stm-section="records"]');
      const select = section?.querySelector('select[data-action="record-table-select"]');
      return {
        optionCount: select?.options.length ?? 0,
        hasSearch: !!section?.querySelector('input[data-action="record-search"]'),
        hasCreate: !!section?.querySelector('button[data-action="create-record"]'),
      };
    });
    check(
      "记录 Tab：表选择器（8 张系统表）+ 搜索 + 新建记录入口",
      recordsTab.optionCount >= 8 && recordsTab.hasSearch && recordsTab.hasCreate,
      JSON.stringify(recordsTab),
    );

    await page.evaluate(() => {
      document.querySelector('#stm-panel .stm-tab[data-tab="settings"]')?.click();
    });
    const settings = await page.evaluate(() => {
      const section = document.querySelector('#stm-panel [data-stm-section="settings"]');
      const text = section?.textContent ?? "";
      const r2Inputs = [...section.querySelectorAll('input[data-stm-field^="r2-"]')];
      const macroInput = section.querySelector('input[data-stm-field="macro-name"]');
      return {
        hasPluginSwitch: !!section?.querySelector('input[data-action="toggle-plugin"]'),
        pluginSwitchOn: section?.querySelector('input[data-action="toggle-plugin"]')?.checked ?? null,
        version: text.match(/v\d+\.\d+\.\d+/)?.[0] ?? "",
        hasStatus: text.includes("运行状态") && text.includes("空间同步正常"),
        // ticket 08：R2 四项为可编辑输入（未配置时值为空）
        r2Editable: r2Inputs.length === 4 && r2Inputs.every((i) => !i.disabled),
        macroDisabled: macroInput?.disabled === true && macroInput?.value === "{{memoryContext}}",
        hasBackup: !!section?.querySelector('button[data-action="export-backup"]')
          && !!section?.querySelector('button[data-action="import-backup"]')
          && !!section?.querySelector('input[data-stm-field="import-backup-file"]'),
        hasSyncStatus: !!section?.querySelector('[data-stm-field="cloud-sync-status"]')
          && !!section?.querySelector('button[data-action="sync-now"]'),
        // ticket 16：对话文件镜像组（开关 + 包含修订历史 + 状态行）
        hasMirror: !!section?.querySelector('input[data-action="toggle-mirror"]')
          && !!section?.querySelector('input[data-action="toggle-mirror-history"]')
          && !!section?.querySelector('[data-stm-field="mirror-status"]'),
      };
    });
    check("设置 Tab：插件开关 + 版本 + 运行状态", settings.hasPluginSwitch && settings.hasStatus, JSON.stringify(settings));
    check("设置 Tab：版本号展示", settings.version === "v0.1.0", settings.version);
    check("设置 Tab：R2 配置可编辑（4 个输入，ticket 08 生效）", settings.r2Editable);
    check("设置 Tab：同步状态组（状态行 + 立即同步按钮）", settings.hasSyncStatus);
    check("设置 Tab：对话文件镜像组（开关 + 修订历史 + 状态行，ticket 16 生效）", settings.hasMirror);
    check("设置 Tab：记忆宏占位（禁用 + 默认名 {{memoryContext}}）", settings.macroDisabled);
    check("设置 Tab：数据备份导出/导入入口就位", settings.hasBackup);

    // 插件总开关：关闭 → extensionSettings 持久化；打开 → 恢复
    await page.evaluate(() => {
      document.querySelector('#stm-panel input[data-action="toggle-plugin"]')?.click();
    });
    await waitUntil(
      page,
      () => {
        const s = SillyTavern.getContext().extensionSettings?.steMemory;
        return s?.enabled === false;
      },
      "插件开关关闭持久化到 extensionSettings",
    );
    const disabledHeader = await page.evaluate(() => {
      const title = document.querySelector("#stm-panel .stm-space-title")?.textContent ?? "";
      return title;
    });
    check("关闭后头部提示「插件已停用」", disabledHeader.includes("插件已停用"), disabledHeader);

    await page.evaluate(() => {
      document.querySelector('#stm-panel input[data-action="toggle-plugin"]')?.click();
    });
    await waitUntil(
      page,
      () => SillyTavern.getContext().extensionSettings?.steMemory?.enabled === true,
      "插件开关重新打开持久化",
    );
    const reEnabledHeader = await page.evaluate(() => document.querySelector("#stm-panel .stm-space-title")?.textContent ?? "");
    check("重新启用后头部恢复空间名", reEnabledHeader === spaceName, reEnabledHeader);

    // 8. 收起按钮 → 面板关闭
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="close-panel"]')?.click();
    });
    await waitUntil(
      page,
      () => !document.getElementById("stm-panel")?.classList.contains("stm-panel--open"),
      "面板收起",
    );
    check("收起按钮关闭面板", true);
    const pressed = await page.evaluate(() => document.querySelector("#top-settings-holder .stm-toolbar-button")?.getAttribute("aria-pressed"));
    check("按钮 aria-pressed 同步为 false", pressed === "false");

    // 9. 桌面视口：浮动面板布局
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
    });
    await waitUntil(
      page,
      () => document.getElementById("stm-panel")?.classList.contains("stm-panel--open"),
      "桌面面板打开",
    );
    await waitMs(300); // 等浮动面板过渡结束再量绘制位置
    const desktopStyle = await page.evaluate(() => {
      const panel = document.getElementById("stm-panel");
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return {
        position: style.position,
        top: style.top,
        right: style.right,
        width: style.width,
        radius: style.borderRadius,
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
        innerHeight: window.innerHeight,
      };
    });
    check(
      "桌面（1280px）：浮动面板且位于视口内",
      desktopStyle.position === "fixed" &&
        desktopStyle.top === "56px" &&
        desktopStyle.right === "16px" &&
        parseFloat(desktopStyle.width) === 400 &&
        desktopStyle.rect.top === 56 &&
        desktopStyle.rect.bottom <= desktopStyle.innerHeight,
      JSON.stringify(desktopStyle),
    );
    await page.evaluate(() => {
      document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
    });
    await waitUntil(
      page,
      () => !document.getElementById("stm-panel")?.classList.contains("stm-panel--open"),
      "桌面面板收起",
    );

    // 10. 优化项 1 回归：存量聊天（无绑定）打开即自动创建空间
    // 复制一个现有聊天文件并去掉 chat_metadata，模拟插件安装前就存在的存量聊天
    const chatDir = readdirSync(ST_CHATS_ROOT).find((d) => d.includes(TEST_CHARACTER));
    const existingChat = readdirSync(path.join(ST_CHATS_ROOT, chatDir)).find((f) => f.endsWith(".jsonl"));
    const srcLines = readFileSync(path.join(ST_CHATS_ROOT, chatDir, existingChat), "utf8").split("\n").filter(Boolean);
    const header = JSON.parse(srcLines[0]);
    delete header.chat_metadata;
    writeFileSync(
      path.join(ST_CHATS_ROOT, chatDir, "legacy-chat.jsonl"),
      [JSON.stringify(header), ...srcLines.slice(1)].join("\n"),
      "utf8",
    );
    const spacesBefore = (await readSteMemoryDb(page)).spaces.length;
    const logsBeforeLegacy = page.__steLogs.length;
    await page.evaluate(async () => {
      await SillyTavern.getContext().openCharacterChat("legacy-chat");
    });
    await waitForNewSteLog(
      page,
      (t) => t.includes("已为对话") && t.includes("legacy-chat"),
      logsBeforeLegacy,
      "存量聊天建空间日志",
    );
    await waitForDbState(
      page,
      (db) => db.spaces.some((s) => s.name.includes("legacy-chat")),
      "存量聊天空间落库",
      15000,
    );
    const legacyDb = await readSteMemoryDb(page);
    const legacyBinding = await page.evaluate(() => SillyTavern.getContext().chatMetadata?.steMemory ?? null);
    check(
      "存量聊天无绑定：打开即自动创建空间 + 写绑定",
      legacyDb.spaces.length === spacesBefore + 1 &&
        legacyDb.spaces.some((s) => s.name.includes("legacy-chat")) &&
        typeof legacyBinding?.spaceId === "string",
      `spaces ${spacesBefore}→${legacyDb.spaces.length}，绑定=${JSON.stringify(legacyBinding)}`,
    );

    // 10. 全流程无插件相关页面错误
    const pluginErrors = pageErrors.filter((e) => e.includes("STE Memory") || e.includes("ste-memory") || e.includes("stm-"));
    check("全流程无插件相关错误", pluginErrors.length === 0, pluginErrors.join(" | ") || "无");

    // 截图留证
    const shotPath = path.join(process.env.TMPDIR ?? "/tmp", `ste-memory-ui-shell-${Date.now()}.png`);
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
