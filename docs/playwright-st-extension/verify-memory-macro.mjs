// ticket 15 手动验收：真实 ST 中「记忆宏注册 → 快照预计算 → 数据变更后展开最新记忆 →
// 宏名自定义生效 → 上限截断 → 停用无注入」
//
// 展开验证走 ST 宏引擎真实路径：macros.engine.evaluate("{{memoryContext}}", {})（引擎
// 公开 API，handler 不消费 env）；数据写入走插件运行时（bootstrap 暴露的
// __STE_MEMORY_RUNTIME__，core 服务层 → displayText/updatedAt/指纹全链路）。
//
// /* global SillyTavern, document, indexedDB, window */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 用法：node verify-memory-macro.mjs（exit 0 = 全流程通过；脚本自清理：删除验收记录并恢复默认设置）
import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** ST 宏引擎真实展开（public API）；env 只需引擎必需的最小面（动态宏表 + postProcess），
 * 宏 handler 不消费 env。缺 dynamicMacros 会 TypeError → 引擎回退原文（不展开）。
 * 只能在 Node 侧调用（page.evaluate）。
 * waitUntil 谓词运行在浏览器上下文：先经 injectExpandHelper 在页面注入
 * window.__steExpand，谓词直接调用它（谓词本身会被序列化，不能引用 Node 闭包）。 */
function expandMacro(page, text) {
  return page.evaluate(
    (t) =>
      SillyTavern.getContext().macros.engine.evaluate(t, {
        dynamicMacros: {},
        functions: { postProcess: (result) => result },
      }),
    text,
  );
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

/** 通过插件运行时建一条记录（core 服务层：必填校验 + 显示文本 + updatedAt，全链路） */
function createRecord(page, spaceId, tableId, payload) {
  return page.evaluate(
    ({ spaceId, tableId, payload }) => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      return runtime.records.create(spaceId, tableId, { payload });
    },
    { spaceId, tableId, payload },
  );
}

/** React 受控输入赋值：原生 setter + input 事件（React 监听原生事件） */
function setFieldValue(page, selector, value) {
  return page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`未找到输入 ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { selector, value },
  );
}

async function main() {
  // 清掉测试角色对话文件残留 → 强制全新建空间路径（与 verify-ui-shell 同法）
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

    const ctxInfo = await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      const status = runtime.manager.getStatus();
      const registry = SillyTavern.getContext().macros.registry;
      return {
        spaceId: status?.kind === "active" ? status.space.id : null,
        hasMemoryContext: registry.hasMacro("memoryContext"),
        macroName: registry.getMacro("memoryContext")?.name ?? null,
      };
    });
    check("默认宏名注册：{{memoryContext}} → 裸标识符 memoryContext 已注册",
      ctxInfo.hasMemoryContext && ctxInfo.macroName === "memoryContext", JSON.stringify(ctxInfo));
    const spaceId = ctxInfo.spaceId;
    if (!spaceId) throw new Error("空间未就绪");

    // 2. 空库（无记录）：展开为空串（空表省略，宏仍注册 = 无注入语义）
    const emptyExpansion = await expandMacro(page, "{{memoryContext}}");
    check("空库展开为空串（空表省略）", emptyExpansion === "", JSON.stringify(emptyExpansion));

    // 3. 创建第一条记录（人物表必填 name）→ kick → 展开含分组标题与显示文本
    const tableInfo = await page.evaluate((spaceId) => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      return runtime.tables.list(spaceId).then((tables) => {
        const table = tables.find((t) => t.key === "characters");
        return runtime.fields.list(spaceId, table.id).then((fields) => ({
          tableId: table.id,
          tableName: table.name,
          nameFieldId: fields.find((f) => f.key === "name").id,
        }));
      });
    }, spaceId);
    const firstRecord = await createRecord(page, spaceId, tableInfo.tableId, {
      [tableInfo.nameFieldId]: "张三",
    });
    await page.evaluate(() => window.__STE_MEMORY_RUNTIME__.macro.kick());
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext}}").includes("张三"),
      "展开包含新记录",
    );
    const afterFirst = await expandMacro(page, "{{memoryContext}}");
    check("数据变更后展开最新记忆（表名标题行 + 记录显示文本）",
      afterFirst.includes(`【${tableInfo.tableName}】`) && afterFirst.includes("张三")
        && !afterFirst.includes("……（已截断）"),
      JSON.stringify(afterFirst));

    // 4. 第二条记录：组内最新在前（李四先于张三）
    const secondRecord = await createRecord(page, spaceId, tableInfo.tableId, { [tableInfo.nameFieldId]: "李四" });
    await page.evaluate(() => window.__STE_MEMORY_RUNTIME__.macro.kick());
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext}}").includes("李四"),
      "展开包含第二条记录",
    );
    const afterSecond = await expandMacro(page, "{{memoryContext}}");
    check("组内最新在前（李四在张三前）",
      afterSecond.indexOf("李四") < afterSecond.indexOf("张三"), JSON.stringify(afterSecond));

    // 5. 上限截断：设置 macroLimit 小值 + kick → 展开以截断标记结尾（整段 10 字符 > 上限 9）
    await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      runtime.settings.write({ ...runtime.settings.read(), macroLimit: 9 });
      return runtime.macro.kick();
    });
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext}}").endsWith("……（已截断）"),
      "展开带截断标记",
    );
    const truncated = await expandMacro(page, "{{memoryContext}}");
    check("超上限尾部截断 + 标记（总长 = 上限 9）",
      truncated.endsWith("……（已截断）") && [...truncated].length === 9,
      JSON.stringify(truncated));

    // 恢复上限到默认：改名步骤的展开断言需要完整内容（截断态下无李四）
    await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      runtime.settings.write({ ...runtime.settings.read(), macroLimit: 2000 });
      return runtime.macro.kick();
    });
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext}}").includes("李四"),
      "恢复上限后展开完整内容",
    );

    // 6. 宏名自定义：设置面板改名 → 旧名注销、新名注册，新名展开同样生效
    await page.evaluate(() => {
      document.querySelector("#top-settings-holder .stm-toolbar-button")?.click();
    });
    await waitUntil(
      page,
      () => {
        const panel = document.getElementById("stm-panel");
        return panel?.classList.contains("stm-panel--open");
      },
      "面板打开",
    );
    await page.evaluate(() => {
      document.querySelector('#stm-panel .stm-tab[data-tab="settings"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-stm-section="settings"] input[data-stm-field="macro-name"]'),
      "设置面板宏名输入就位",
    );
    await setFieldValue(page, '#stm-panel input[data-stm-field="macro-name"]', "{{myMemory}}");
    await waitUntil(
      page,
      () => {
        const registry = SillyTavern.getContext().macros.registry;
        return registry.hasMacro("myMemory") && !registry.hasMacro("memoryContext");
      },
      "改名后重注册（旧名注销）",
    );
    const renamed = await expandMacro(page, "{{myMemory}}");
    check("自定义宏名生效：{{myMemory}} 展开最新记忆（含李四）",
      renamed.includes("李四"), JSON.stringify(renamed));

    // 7. 恢复默认设置（等防抖落盘，保证后续运行起点干净）+ 清理验收记录
    await page.evaluate(() => {
      const runtime = window.__STE_MEMORY_RUNTIME__;
      runtime.settings.write({
        ...runtime.settings.read(),
        macroName: "{{memoryContext}}",
        macroLimit: 2000,
      });
    });
    await waitMs(2500); // saveSettingsDebounced 1s 防抖 + 余量
    await page.evaluate(
      ({ spaceId, tableId, items }) => {
        const runtime = window.__STE_MEMORY_RUNTIME__;
        return Promise.all(
          items.map((item) =>
            runtime.records.delete(spaceId, tableId, item.id, item.revisionId, "user"),
          ),
        );
      },
      {
        spaceId,
        tableId: tableInfo.tableId,
        items: [
          { id: firstRecord.id, revisionId: firstRecord.revisionId },
          { id: secondRecord.id, revisionId: secondRecord.revisionId },
        ],
      },
    );
    await waitUntil(
      page,
      () => window.__steExpand("{{memoryContext}}").includes("李四") === false,
      "验收记录清理后展开不含残留",
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
