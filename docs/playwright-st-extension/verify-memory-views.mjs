// ticket 02 / ADR 0025 手动验收：真实 ST 中「记忆视图配置 → {{宏名::视图名}} 展开 →
// 筛选/条数/投影语义 → 未知视图空串 → 世界书条目关键词触发注入 → 面板冒烟」
//
// 展开验证走 ST 宏引擎真实路径（macros.engine.evaluate）；世界书注入走 ST 扫描真实
// 路径（getWorldInfoPrompt dry run：条目内容在激活时无条件 substituteParams——
// world-info.js:4937 已核实）；数据写入走插件运行时（__STE_MEMORY_RUNTIME__，
// core 服务层全链路）。
//
// /* global SillyTavern, document, indexedDB, window */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 用法：node verify-memory-views.mjs（exit 0 = 全流程通过；脚本自清理：删除验收记录/
// 视图设置/世界书条目并恢复默认设置）
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";
const TEST_CHARACTER = "Seraphina";
const WI_BOOK_NAME = "ste-memory 验收书";
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

async function waitUntil(page, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await waitMs(250);
  }
  throw new Error(`等待条件超时：${label}`);
}

async function waitForNewSteLog(page, matcher, since, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = page.__steLogs.slice(since).find((t) => matcher(t));
    if (found) return found;
    await waitMs(250);
  }
  throw new Error(`等待插件日志超时：${label}`);
}

/** 页面注入展开助手（waitUntil 谓词使用；引擎对象是 ST 全局单例，注入一次即可） */
async function injectExpandHelper(page) {
  await page.evaluate(() => {
    window.__steExpand = (text) =>
      SillyTavern.getContext().macros.engine.evaluate(text, {
        dynamicMacros: {},
        functions: { postProcess: (result) => result },
      });
  });
}

async function main() {
  // 清掉测试角色对话文件残留 → 强制全新建空间路径（与 verify-memory-macro 同法）
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
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[STE Memory]")) pageErrors.push(msg.text());
  });

  try {
    // 1. 加载插件 + 打开测试角色对话（自动建空间）
    await page.goto(ST_URL, { waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), 0, "插件初始化日志");
    await injectExpandHelper(page);
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 30000 });
    const logCountBeforeOpen = page.__steLogs.length;
    await page.evaluate(async (characterName) => {
      const ctx = SillyTavern.getContext();
      const idx = ctx.characters.findIndex((c) => c.name === characterName);
      await ctx.selectCharacterById(idx >= 0 ? idx : 0);
    }, TEST_CHARACTER);
    await waitForNewSteLog(page, (t) => t.includes("已为对话"), logCountBeforeOpen, "首次建空间日志");
    await waitUntil(page, () => SillyTavern.getContext().chatId !== undefined, "对话 chatId 就位");

    // 2. 建自定义表「伏笔」（name/status 字段）+ 四条记录（四种状态各一）
    const spaceId = await page.evaluate(() => {
      const status = window.__STE_MEMORY_RUNTIME__.manager.getStatus();
      return status?.kind === "active" ? status.space.id : null;
    });
    if (!spaceId) throw new Error("空间未就绪");
    const setup = await page.evaluate(async (spaceId) => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      const table = await runtime.tables.create(spaceId, {
        key: "plots",
        kind: "custom",
        name: "伏笔",
        description: "剧情伏笔台账",
        prompt: "",
      });
      const statusField = await runtime.fields.create(spaceId, table.id, {
        key: "status",
        name: "状态",
        type: "single_select",
        required: false,
        prompt: "",
        enabled: true,
        position: 1,
        options: ["埋设中", "已触发", "已回收", "已放弃"],
      });
      const nameField = await runtime.fields.create(spaceId, table.id, {
        key: "name",
        name: "名称",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
      });
      const mk = (name, status) =>
        runtime.records.create(spaceId, table.id, { payload: { [nameField.id]: name, [statusField.id]: status } });
      const r1 = await mk("深夜的钟声", "埋设中");
      const r2 = await mk("断剑", "已触发");
      const r3 = await mk("旧地图", "已回收");
      const r4 = await mk("破碎的约定", "已放弃");
      return { tableId: table.id, statusFieldId: statusField.id, records: [r1, r2, r3, r4] };
    }, spaceId);
    check("建伏笔表 + 4 条记录（埋设中/已触发/已回收/已放弃）", setup.records.length === 4);

    // 3. 配置视图（排除已回收/已放弃 → 只留 2 条；投影 名称/状态）+ kick
    await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      runtime.settings.write({
        ...runtime.settings.read(),
        memoryViews: [
          {
            name: "未完成伏笔",
            tableKey: "plots",
            condition: { fieldKey: "status", values: ["埋设中", "已触发"] },
            limit: 10,
            projection: ["name", "status"],
          },
          {
            name: "最近两条",
            tableKey: "plots",
            condition: null,
            limit: 2,
            projection: [],
          },
          {
            name: "全部伏笔",
            tableKey: "plots",
            condition: null,
            limit: null,
            projection: [],
          },
        ],
      });
      return runtime.macro.kick();
    });
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext::未完成伏笔}}").includes("深夜的钟声"),
      "视图展开包含筛选命中的记录",
    );

    // 4. 视图展开语义：in 多值筛选（排除已回收/已放弃）+ 投影「字段名：值」渲染
    const filtered = await page.evaluate(() => window.__steExpand("{{memoryContext::未完成伏笔}}"));
    check(
      "筛选（in 排除已回收/已放弃）+ 投影渲染",
      filtered.includes("名称：深夜的钟声，状态：埋设中")
        && filtered.includes("名称：断剑，状态：已触发")
        && !filtered.includes("旧地图")
        && !filtered.includes("破碎的约定")
        && !filtered.includes("【"),
      JSON.stringify(filtered),
    );

    // 5. 条数上限 + $updated_at 倒序：最近两条 = 后创建的两条（最新在前）
    const recent = await page.evaluate(() => window.__steExpand("{{memoryContext::最近两条}}"));
    const recentLines = recent.split("\n").filter((line) => line.length > 0);
    check(
      "条数上限（limit=2）+ $updated_at 倒序（最新在前）",
      recentLines.length === 2
        && recentLines[0].includes("破碎的约定")
        && recentLines[1].includes("旧地图")
        && !recent.includes("断剑"),
      JSON.stringify(recent),
    );

    // 6. 无投影视图 = 显示文本；无条数上限 = 100 语义（记录不足全量返回）
    const allText = await page.evaluate(() => window.__steExpand("{{memoryContext::全部伏笔}}"));
    check("无投影视图：显示文本单行化（无分组标题）", allText.includes("深夜的钟声") && !allText.includes("【"), JSON.stringify(allText));

    // 7. 无参宏回归 = 默认快照（分组标题 + 全部启用表）；未知视图 = 空串
    const noArg = await page.evaluate(() => window.__steExpand("{{memoryContext}}"));
    check("无参宏回归：默认快照（分组标题）", noArg.includes("【伏笔】") && noArg.includes("深夜的钟声"), JSON.stringify(noArg));
    const unknown = await page.evaluate(() => window.__steExpand("{{memoryContext::不存在的视图}}"));
    check("未知视图名：空串不阻断", unknown === "", JSON.stringify(unknown));

    // 8. 世界书条目关键词触发：建书 + 条目（内容 = 宏）→ 分配给当前对话 → dry-run 扫描
    const wi = await page.evaluate(async (bookName) => {      const ctx = SillyTavern.getContext();
      await ctx.saveWorldInfo(bookName, { entries: {} }, true);
      await ctx.updateWorldInfoList();
      ctx.chatMetadata["world_info"] = bookName;
      ctx.saveMetadataDebounced?.();
      const data = await ctx.loadWorldInfo(bookName);
      const uid = Object.keys(data.entries).length;
      data.entries[uid] = {
        uid,
        key: ["伏笔"],
        keysecondary: [],
        content: "{{memoryContext::未完成伏笔}}",
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
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: "",
        role: 0,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: 0,
        addMemo: false,
      };
      await ctx.saveWorldInfo(bookName, data, true);
      return uid;
    }, WI_BOOK_NAME);
    const wiScan = await page.evaluate(async () => {
      const ctx = SillyTavern.getContext();
      // 剧情文本含关键词「伏笔」→ 条目激活 → 内容宏展开（dry run 不写定时状态）
      const result = await ctx.getWorldInfoPrompt(["伏笔 相关剧情出现了。"], 8192, true);
      return result.worldInfoString;
    });
    check(
      "世界书条目（关键词触发）真实展开视图宏",
      wiScan.includes("名称：深夜的钟声，状态：埋设中") && wiScan.includes("断剑"),
      JSON.stringify(wiScan),
    );

    // 9. 面板冒烟：设置 Tab「记忆宏」组出现视图区块（列表 + 新建入口）
    await page.evaluate(() => {
      document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
    });
    await waitUntil(
      page,
      () => document.getElementById("stm-panel")?.classList.contains("stm-panel--open"),
      "面板打开",
    );
    await page.evaluate(() => {
      document.querySelector('#stm-panel .stm-tab[data-tab="settings"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-stm-section="memory-views"]'),
      "设置面板记忆视图区块就位",
    );
    const panelHtml = await page.evaluate(() => {
      const section = document.querySelector('#stm-panel [data-stm-section="memory-views"]');
      return {
        rows: section?.querySelectorAll('[data-action="edit-memory-view"]').length ?? 0,
        hasAdd: !!section?.querySelector('[data-action="add-memory-view"]'),
        hasUnknownViewError: false,
      };
    });
    check(
      "面板冒烟：视图列表 3 行 + 新建入口",
      panelHtml.rows === 3 && panelHtml.hasAdd,
      JSON.stringify(panelHtml),
    );

    // 10. 自清理：删记录 → 视图设置清空 → WI 条目删除 + 解除对话绑定 → 恢复默认设置
    await page.evaluate(
      ({ spaceId, tableId, records }) => {
        const runtime = window.__STE_MEMORY_RUNTIME__;
        return Promise.all(
          records.map((item) =>
            runtime.records.delete(spaceId, tableId, item.id, item.revisionId, "user"),
          ),
        );
      },
      { spaceId, tableId: setup.tableId, records: setup.records },
    );
    await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      runtime.settings.write({ ...runtime.settings.read(), memoryViews: [] });
      return runtime.macro.kick();
    });
    await page.evaluate(async (bookName) => {
      const ctx = SillyTavern.getContext();
      const data = await ctx.loadWorldInfo(bookName);
      if (data) {
        data.entries = {};
        await ctx.saveWorldInfo(bookName, data, true);
      }
      delete ctx.chatMetadata["world_info"];
      ctx.saveMetadataDebounced?.();
    }, WI_BOOK_NAME);
    await waitMs(2500); // saveSettingsDebounced 1s 防抖 + 余量
    await waitUntil(
      page,
      () => !window.__steExpand("{{memoryContext::未完成伏笔}}").includes("深夜的钟声"),
      "清理后视图展开为空",
    );

    const pluginErrors = pageErrors.filter((e) => e.includes("[STE Memory]") || e.includes("ste-memory"));
    check("全流程无插件相关页面错误", pluginErrors.length === 0, pluginErrors.join(" | "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
