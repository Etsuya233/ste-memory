// ticket 11 手动验收：真实 ST 中「建自定义表 → 建字段 → 配显示策略 → 记录 CRUD 全流程
// （含校验错误/停用字段值保留/来源徽标/修订摘要）→ 证据楼层 chip 渲染 + 跳转 + 摘录」
// /* global SillyTavern, document, indexedDB, window */
// 前置：ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/。
// 用法：node verify-record-crud.mjs（exit 0 = 全流程通过；脚本自清理：删除验收表与种子数据）
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";
const TEST_CHARACTER = "Seraphina";
const ST_CHATS_ROOT = process.env.STE_ST_DATA
  ?? "/home/etsuya/programming/ste-memory/tmp/SillyTavern_Source_Code/data/default-user/chats";

/** 验收专用自定义表（自包含：结束时整表删除，级联清字段/记录/历史；证据行单独清理） */
const TEST_TABLE_KEY = "verify_records";

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

async function waitUntil(page, predicate, label, timeoutMs = 20000, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return;
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

/** 读插件 Dexie 库（ste-memory）：空间/表/字段/记录原始行（indexedDB，不依赖 Dexie 全局） */
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
    const [spaces, tables, fields, records] = await Promise.all([
      all("memorySpaces"),
      all("memoryTables"),
      all("memoryFields"),
      all("memoryRecords"),
    ]);
    db.close();
    return { spaces, tables, fields, records };
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

/** 写插件 Dexie 库（验收种子与清理用，直接原始 indexedDB 读写事务）；
 * 函数体经字符串重建，外层闭包变量一律走 args 显式传入 */
async function writeSteMemoryDb(page, fn, args = {}) {
  return page.evaluate(
    async ({ fnSource, args: fnArgs }) => {
      const fn = new Function(`return (${fnSource});`)();
      const open = indexedDB.open("ste-memory");
      const db = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      try {
        await fn(db, fnArgs);
      } finally {
        db.close();
      }
    },
    { fnSource: fn.toString(), args },
  );
}

/** React 受控输入赋值：原生 setter + input/change 事件（React 监听原生事件） */
function setFieldValue(page, selector, value, kind = "input") {
  return page.evaluate(
    ({ selector, value, kind }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`未找到输入 ${selector}`);
      const proto =
        kind === "textarea"
          ? window.HTMLTextAreaElement.prototype
          : kind === "select"
            ? window.HTMLSelectElement.prototype
            : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event(kind === "select" ? "change" : "input", { bubbles: true }));
    },
    { selector, value, kind },
  );
}

async function openPanel(page) {
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
}

async function clickTab(page, tab) {
  await page.evaluate((t) => {
    document.querySelector(`#stm-panel .stm-tab[data-tab="${t}"]`)?.click();
  }, tab);
}

async function selectCustomTable(page, tableId) {
  await setFieldValue(
    page,
    '#stm-panel select[data-action="record-table-select"]',
    tableId,
    "select",
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // 移动端优先
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
  // 删除确认对话框（window.confirm）：一律接受
  page.on("dialog", (dialog) => void dialog.accept());

  let seededEvidenceId = null;
  let seededRecordId = null;

  try {
    // 1. 加载插件 + 打开测试角色对话（自动建空间）
    await page.goto(ST_URL, { waitUntil: "domcontentloaded" });
    await waitForNewSteLog(page, (t) => t.includes("已加载"), 0, "插件初始化日志");
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
    // 绑定优先（chatMetadata.steMemory.spaceId）：历次运行会累积孤儿空间，spaces 顺序不可靠
    const boundSpaceId = await page.evaluate(
      () => SillyTavern.getContext().chatMetadata?.steMemory?.spaceId,
    );
    const spaceId = boundSpaceId ?? db0.spaces[0]?.id;
    if (!spaceId) throw new Error("无法确定当前对话的记忆空间");

    // 幂等清理：移除历次验收残留的 verify_records 表（原始级联）与固定 id 种子行
    await page.evaluate(async ({ key, evidenceId }) => {
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
      const [tables, fields, records, history] = await Promise.all([
        all("memoryTables"),
        all("memoryFields"),
        all("memoryRecords"),
        all("memoryRecordHistory"),
      ]);
      const tableIds = tables.filter((t) => t.key === key).map((t) => t.id);
      const fieldIds = new Set(
        fields.filter((f) => tableIds.includes(f.tableId)).map((f) => f.id),
      );
      const recordIds = new Set(
        records.filter((r) => tableIds.includes(r.tableId)).map((r) => r.id),
      );
      const del = (store, id) =>
        db.transaction(store, "readwrite").objectStore(store).delete(id);
      for (const id of history.filter((h) => tableIds.includes(h.tableId)).map((h) => h.id)) {
        del("memoryRecordHistory", id);
      }
      for (const id of recordIds) del("memoryRecords", id);
      for (const id of fieldIds) del("memoryFields", id);
      for (const id of tableIds) del("memoryTables", id);
      db.transaction("memoryEvidence", "readwrite").objectStore("memoryEvidence").delete(evidenceId);
      db.close();
    }, { key: TEST_TABLE_KEY, evidenceId: "ev-verify-floor-0" });

    await openPanel(page);

    // 2. 建自定义表（UI 全流程：建表 → 6 个字段 → 显示策略）
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="create-table"]')?.click();
    });
    await setFieldValue(page, '[data-stm-field="table-key"]', TEST_TABLE_KEY);
    await setFieldValue(page, '[data-stm-field="table-name"]', "验收记录表");
    await setFieldValue(page, '[data-stm-field="table-description"]', "ticket 11 手动验收用表");
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="editor-submit"]')?.click();
    });
    await waitForDbState(
      page,
      (db) => db.tables.some((t) => t.key === TEST_TABLE_KEY),
      "自定义表落库",
    );
    const table = (await readSteMemoryDb(page)).tables.find((t) => t.key === TEST_TABLE_KEY);
    const tableId = table.id;
    check("建表：verify_records 落库", !!table, tableId);

    /** 经 UI 添加一个字段：key/name/type（select 值）/required/options */
    async function addFieldUi({ key, name, type = "short_text", required = false, options = "" }) {
      await page.evaluate((tid) => {
        document.querySelector(`#stm-panel [data-action="add-field"][data-table-id="${tid}"]`)?.click();
      }, tableId);
      await setFieldValue(page, '[data-stm-field="field-key"]', key);
      await setFieldValue(page, '[data-stm-field="field-name"]', name);
      if (type !== "short_text") {
        await setFieldValue(page, '[data-stm-field="field-type"]', type, "select");
      }
      if (options) {
        await setFieldValue(page, '[data-stm-field="field-options"]', options, "textarea");
      }
      if (required) {
        await page.evaluate(() => {
          const box = document.querySelector('[data-stm-field="field-required"]');
          if (box && !box.checked) box.click();
        });
      }
      await page.evaluate(() => {
        document.querySelector('#stm-panel [data-action="editor-submit"]')?.click();
      });
      await waitForDbState(
        page,
        (db) => db.fields.some((f) => f.key === key && f.tableId === tableId),
        `字段 ${key} 落库`,
      );
    }

    await addFieldUi({ key: "name", name: "名字", required: true });
    await addFieldUi({ key: "note", name: "备注", type: "long_text" });
    await addFieldUi({ key: "count", name: "数量", type: "integer" });
    await addFieldUi({ key: "tags", name: "标签", type: "short_text_list" });
    await addFieldUi({ key: "category", name: "分类", type: "single_select", options: "甲\n乙\n丙" });
    await addFieldUi({ key: "born", name: "日期", type: "date" });
    const fields = (await readSteMemoryDb(page)).fields.filter((f) => f.tableId === tableId);
    check("建字段：6 个字段落库", fields.length === 6, `fields=${fields.length}`);

    // 显示策略：显示字段 = 名字（short_text，必填）
    await page.evaluate((tid) => {
      document.querySelector(`#stm-panel [data-action="edit-display-strategy"][data-table-id="${tid}"]`)?.click();
    }, tableId);
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-stm-field="display-strategy-field"]'),
      "显示策略编辑器就位",
    );
    await page.evaluate(() => {
      const select = document.querySelector('[data-stm-field="display-strategy-field"]');
      const option = [...select.options].find((o) => o.text.includes("名字"));
      if (!option) throw new Error("显示策略字段选项缺失");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="editor-submit"]')?.click();
    });
    await waitForDbState(
      page,
      (db) => {
        const t = db.tables.find((x) => x.id === tableId);
        return t?.displayStrategy?.type === "field" && t.displayStrategy.fieldId === fields.find((f) => f.key === "name").id;
      },
      "显示策略保存",
    );
    check("显示策略：字段=名字 保存成功", true);

    // 3. 记录 tab：选择验收表 → 空状态
    await clickTab(page, "records");
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel select[data-action="record-table-select"]'),
      "记录 tab 表选择器就位",
    );
    await selectCustomTable(page, tableId);
    await waitUntil(
      page,
      (tid) =>
        document.querySelector('#stm-panel [data-action="record-table-select"]')?.value === tid,
      "验收表选中",
      20000,
      tableId,
    );
    await waitUntil(
      page,
      () => {
        const empty = document.querySelector('#stm-panel [data-stm-section="records"] .stm-empty-title');
        return empty?.textContent?.includes("还没有记录");
      },
      "记录空状态",
    );
    check("记录 tab：验收表空状态", true);

    // 4. 创建记录：先触发必填校验错误，再填全字段成功
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="create-record"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-action="save-record"]'),
      "记录表单就位",
    );
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="save-record"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-stm-section="records"] .stm-form-error'),
      "必填校验错误出现",
    );
    const requiredError = await page.evaluate(
      () => document.querySelector('#stm-panel [data-stm-section="records"] .stm-form-error')?.textContent ?? "",
    );
    check("必填校验：名字为空报错（文案清晰）", requiredError.includes("请填写"), requiredError);

    await setFieldValue(page, '[data-stm-field="record-value-name"]', "阿尔法");
    await setFieldValue(page, '[data-stm-field="record-value-note"]', "测试备注", "textarea");
    await setFieldValue(page, '[data-stm-field="record-value-count"]', "3");
    await setFieldValue(page, '[data-stm-field="record-value-tags"]', "a、b、c");
    await setFieldValue(page, '[data-stm-field="record-value-category"]', "乙", "select");
    await setFieldValue(page, '[data-stm-field="record-value-born"]', "2026-08-09");
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="save-record"]')?.click();
    });
    await waitForDbState(
      page,
      (db) => db.records.some((r) => r.tableId === tableId && r.payload && String(r.payload[fields.find((f) => f.key === "name").id] ?? "") === "阿尔法"),
      "记录创建落库",
    );
    await waitUntil(
      page,
      () => {
        const rows = document.querySelectorAll('#stm-panel [data-stm-section="records"] .stm-record-row');
        return rows.length === 1;
      },
      "记录列表出现 1 行",
    );
    const listRow = await page.evaluate(() => {
      const row = document.querySelector('#stm-panel [data-stm-section="records"] .stm-record-row');
      return {
        display: row?.querySelector(".stm-record-display")?.textContent ?? "",
        badge: row?.querySelector(".stm-source-badge")?.textContent ?? "",
      };
    });
    check(
      "列表行：显示文本=名字值 + 来源徽标=手动",
      listRow.display === "阿尔法" && listRow.badge === "手动",
      JSON.stringify(listRow),
    );

    // 5. 搜索过滤（服务端 search：命中显示文本与字段值）
    await setFieldValue(page, '[data-stm-field="record-search"]', "阿尔法");
    await waitUntil(
      page,
      () => document.querySelectorAll('#stm-panel [data-stm-section="records"] .stm-record-row').length === 1,
      "搜索命中 1 行",
    );
    await setFieldValue(page, '[data-stm-field="record-search"]', "不存在关键词xyz");
    await waitUntil(
      page,
      () => {
        const empty = document.querySelector('#stm-panel [data-stm-section="records"] .stm-empty-title');
        return empty?.textContent?.includes("还没有记录");
      },
      "搜索无结果空状态",
    );
    check("搜索：命中与空结果状态正确", true);
    await setFieldValue(page, '[data-stm-field="record-search"]', "");
    await waitUntil(
      page,
      () => document.querySelectorAll('#stm-panel [data-stm-section="records"] .stm-record-row').length === 1,
      "清空搜索恢复列表",
    );

    // 6. 详情：字段值 / 来源徽标 / 无证据标注 / 分页信息
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="open-record"]')?.click();
    });
    await waitUntil(
      page,
      () => !!document.querySelector('#stm-panel [data-stm-section="records"] .stm-record-detail'),
      "记录详情打开",
    );
    const detail1 = await page.evaluate(() => {
      const section = document.querySelector('#stm-panel [data-stm-section="records"]');
      const fieldText = (name) =>
        [...section.querySelectorAll(".stm-record-field")]
          .find((li) => li.querySelector(".stm-record-field-name")?.textContent?.includes(name))
          ?.querySelector(".stm-record-field-value")?.textContent ?? "";
      return {
        display: section.querySelector(".stm-record-display-large")?.textContent ?? "",
        badge: section.querySelector(".stm-record-meta .stm-source-badge")?.textContent ?? "",
        noEvidence: section.querySelector(".stm-no-evidence")?.textContent ?? "",
        name: fieldText("名字"),
        note: fieldText("备注"),
        count: fieldText("数量"),
        tags: fieldText("标签"),
        category: fieldText("分类"),
        born: fieldText("日期"),
      };
    });
    check(
      "详情：显示文本 + 字段值全量正确",
      detail1.display === "阿尔法" &&
        detail1.badge === "手动" &&
        detail1.noEvidence.includes("无证据（手动记录）") &&
        detail1.name === "阿尔法" &&
        detail1.note === "测试备注" &&
        detail1.count === "3" &&
        detail1.tags === "a、b、c" &&
        detail1.category === "乙" &&
        detail1.born === "2026-08-09",
      JSON.stringify(detail1),
    );

    // 7. 停用字段的值保留可查看：表格 tab 停用「备注」→ 详情仍显示值 + 已停用徽标 → 恢复
    const noteField = fields.find((f) => f.key === "note");
    /** 表格 tab 展开验收表卡片（tab 重挂后展开态重置，字段开关在展开区） */
    async function expandTestTable() {
      await waitUntil(
        page,
        (tid) =>
          !!document.querySelector(`#stm-panel [data-action="expand-table"][data-table-id="${tid}"]`),
        "表格卡片就位",
        20000,
        tableId,
      );
      await page.evaluate((tid) => {
        const btn = document.querySelector(
          `#stm-panel [data-action="expand-table"][data-table-id="${tid}"]`,
        );
        if (btn?.getAttribute("aria-expanded") === "false") btn.click();
      }, tableId);
      await waitUntil(
        page,
        (fid) =>
          !!document.querySelector(
            `#stm-panel [data-action="toggle-field"][data-field-id="${fid}"]`,
          ),
        "字段开关就位",
        20000,
        noteField.id,
      );
    }
    await clickTab(page, "tables");
    await expandTestTable();
    await page.evaluate((fid) => {
      const box = document.querySelector(`#stm-panel [data-action="toggle-field"][data-field-id="${fid}"]`);
      if (box?.checked) box.click();
    }, noteField.id);
    await waitForDbState(
      page,
      (db) => db.fields.find((f) => f.id === noteField.id)?.enabled === false,
      "备注字段停用落库",
    );
    await clickTab(page, "records");
    await waitUntil(page, () => !!document.querySelector('#stm-panel select[data-action="record-table-select"]'), "记录 tab 就位");
    await selectCustomTable(page, tableId);
    await waitUntil(page, () => !!document.querySelector('#stm-panel [data-action="open-record"]'), "记录行就位");
    await page.evaluate(() => {
      document.querySelector('#stm-panel [data-action="open-record"]')?.click();
    });
    await waitUntil(page, () => !!document.querySelector('#stm-panel .stm-record-detail'), "详情重开");
    const disabledField = await page.evaluate(() => {
      const section = document.querySelector('#stm-panel [data-stm-section="records"]');
      const li = [...section.querySelectorAll(".stm-record-field")]
        .find((x) => x.querySelector(".stm-record-field-name")?.textContent?.includes("备注"));
      return {
        badge: li?.querySelector(".stm-field-disabled")?.textContent ?? "",
        value: li?.querySelector(".stm-record-field-value")?.textContent ?? "",
      };
    });
    check(
      "停用字段：详情保留值 + 已停用徽标",
      disabledField.badge === "已停用" && disabledField.value === "测试备注",
      JSON.stringify(disabledField),
    );
    // 恢复字段启用（现场清理）
    await clickTab(page, "tables");
    await expandTestTable();
    await page.evaluate((fid) => {
      const box = document.querySelector(`#stm-panel [data-action="toggle-field"][data-field-id="${fid}"]`);
      if (box && !box.checked) box.click();
    }, noteField.id);
    await waitForDbState(page, (db) => db.fields.find((f) => f.id === noteField.id)?.enabled === true, "备注字段恢复启用");

    // 8. 编辑：改备注 → 详情更新 + 修订摘要（手动修订）
    await clickTab(page, "records");
    await waitUntil(page, () => !!document.querySelector('#stm-panel select[data-action="record-table-select"]'), "记录 tab 就位");
    await selectCustomTable(page, tableId);
    await waitUntil(page, () => !!document.querySelector('#stm-panel [data-action="open-record"]'), "记录行就位");
    await page.evaluate(() => document.querySelector('#stm-panel [data-action="open-record"]')?.click());
    await waitUntil(page, () => !!document.querySelector('#stm-panel [data-action="edit-record"]'), "详情就位");
    await page.evaluate(() => document.querySelector('#stm-panel [data-action="edit-record"]')?.click());
    await waitUntil(page, () => !!document.querySelector('#stm-panel [data-action="save-record"]'), "编辑表单就位");
    await setFieldValue(page, '[data-stm-field="record-value-note"]', "新备注", "textarea");
    await page.evaluate(() => document.querySelector('#stm-panel [data-action="save-record"]')?.click());
    await waitUntil(
      page,
      () => {
        const section = document.querySelector('#stm-panel [data-stm-section="records"]');
        const li = [...(section?.querySelectorAll(".stm-record-field") ?? [])].find((x) =>
          x.querySelector(".stm-record-field-name")?.textContent?.includes("备注"),
        );
        return li?.querySelector(".stm-record-field-value")?.textContent === "新备注";
      },
      "详情反映新备注",
    );
    const revisionLine = await page.evaluate(
      () => document.querySelector('#stm-panel .stm-record-revision')?.textContent ?? "",
    );
    check(
      "编辑：详情更新 + 修订摘要（手动修订）",
      revisionLine.includes("手动修订") && revisionLine.includes("共 1 次修订"),
      revisionLine,
    );

    // 9. 删除记录：确认对话框 → 列表空
    await page.evaluate(() => document.querySelector('#stm-panel [data-action="delete-record"]')?.click());
    await waitForDbState(
      page,
      (db) => db.records.filter((r) => r.tableId === tableId).length === 0,
      "记录删除落库",
    );
    await waitUntil(
      page,
      () => document.querySelector('#stm-panel [data-stm-section="records"] .stm-empty-title')?.textContent?.includes("还没有记录"),
      "删除后列表空",
    );
    check("删除：确认后记录消失", true);

    // 10. 证据楼层 chip：造一条含 sync_floor 证据的 Agent 记录（原始 indexedDB 种子）
    // 并保证 chat 有可跳转消息：以「当前 chat 长度」为新推送消息的楼层（无条件推送）
    const evidenceFloor = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.evaluate(() => {
      const ctx = SillyTavern.getContext();
      const message = {
        name: "User",
        is_user: true,
        is_name: true,
        is_system: false,
        send_date: Date.now() / 1000,
        mes: "验收用的楼层消息（证据摘录来源）",
        swipes: [],
        swipe_info: {},
        extra: {},
      };
      ctx.chat.push(message);
      ctx.addOneMessage(message, { scroll: false });
    });
    await waitUntil(
      page,
      () => SillyTavern.getContext().chat.length > 0,
      "chat 至少 1 条消息",
    );

    const nameField = fields.find((f) => f.key === "name");
    const now = new Date().toISOString();
    seededEvidenceId = "ev-verify-floor-0";
    seededRecordId = "record-verify-evidence";
    await writeSteMemoryDb(
      page,
      (db, a) => {
        const evidence = db.transaction("memoryEvidence", "readwrite").objectStore("memoryEvidence");
        evidence.put({
          id: a.evidenceId,
          memorySpaceId: a.spaceId,
          source_type: "sync_floor",
          source_id: a.floor,
          storage_mode: "reference",
          extraProps: {},
        });
        const records = db.transaction("memoryRecords", "readwrite").objectStore("memoryRecords");
        records.put({
          id: a.recordId,
          memorySpaceId: a.spaceId,
          tableId: a.tableId,
          payload: { [a.nameFieldId]: "证据记录" },
          fieldEvidence: {
            [a.nameFieldId]: [
              {
                evidence_id: a.evidenceId,
                source_type: "sync_floor",
                source_id: a.floor,
                storage_mode: "reference",
                extraProps: {},
              },
            ],
          },
          displayText: "证据记录",
          source: { type: "source", sourceTime: null, sourceLocation: null },
          revisionId: "rev-verify-evidence",
          revisionSource: "agent",
          createdAt: a.now,
          updatedAt: a.now,
        });
      },
      {
        spaceId,
        tableId,
        nameFieldId: nameField.id,
        evidenceId: seededEvidenceId,
        recordId: seededRecordId,
        floor: evidenceFloor,
        now,
      },
    );

    // 重挂载记录 tab（切 tab 会卸载/重挂 RecordsTab → 重取数据）
    await clickTab(page, "tasks");
    await clickTab(page, "records");
    await waitUntil(page, () => !!document.querySelector('#stm-panel select[data-action="record-table-select"]'), "记录 tab 就位");
    await selectCustomTable(page, tableId);
    await waitUntil(page, () => !!document.querySelector('#stm-panel [data-action="open-record"]'), "证据记录行就位");
    await page.evaluate(() => document.querySelector('#stm-panel [data-action="open-record"]')?.click());
    await waitUntil(page, () => !!document.querySelector('#stm-panel .stm-evidence-chip--floor'), "证据 chip 渲染");

    const chipState = await page.evaluate((floor) => {
      const section = document.querySelector('#stm-panel [data-stm-section="records"]');
      const chip = section.querySelector(".stm-evidence-chip--floor");
      return {
        text: chip?.textContent ?? "",
        badge: section.querySelector(".stm-record-meta .stm-source-badge")?.textContent ?? "",
        noEvidence: section.querySelector(".stm-no-evidence")?.textContent ?? "",
        chipClass: chip?.className ?? "",
        expect: `#${floor}`,
      };
    }, evidenceFloor);
    check(
      "证据 chip：铜绿签名类 + 等宽 #N + 来源=Agent + 无「无证据」标注",
      chipState.text === chipState.expect &&
        chipState.chipClass.includes("stm-evidence-chip--floor") &&
        chipState.badge === "Agent" &&
        chipState.noEvidence === "",
      JSON.stringify(chipState),
    );

    // 悬停 → 浮出原文摘录
    const chipHandle = page.locator("#stm-panel .stm-evidence-chip--floor").first();
    await chipHandle.hover();
    await waitUntil(
      page,
      () => !!document.querySelector("#stm-panel .stm-evidence-popover"),
      "摘录浮层出现",
    );
    const popover = await page.evaluate((floor) => {
      const el = document.querySelector("#stm-panel .stm-evidence-popover");
      return {
        floor: el?.querySelector(".stm-evidence-popover-floor")?.textContent ?? "",
        name: el?.querySelector(".stm-evidence-popover-name")?.textContent ?? "",
        content: el?.querySelector(".stm-evidence-popover-content")?.textContent ?? "",
        expectFloor: `#${floor}`,
      };
    }, evidenceFloor);
    check(
      "悬停摘录：楼层 #N + 发送者 + 原文片段",
      popover.floor.includes(popover.expectFloor) && popover.content.includes("验收用的楼层消息"),
      JSON.stringify(popover),
    );
    // 移开鼠标关闭浮层（清理）
    await page.mouse.move(0, 0);

    // 点按 → 跳转 ST 对应消息（stm-floor-flash 高亮）
    await chipHandle.click();
    await waitMs(400);
    const jumpState = await page.evaluate((floor) => {
      const el = document.querySelector(`#chat .mes[mesid="${floor}"]`);
      return {
        found: !!el,
        flashed: el?.classList.contains("stm-floor-flash") ?? false,
      };
    }, evidenceFloor);
    check(
      "点按跳转：楼层消息高亮（stm-floor-flash）",
      jumpState.found && jumpState.flashed,
      JSON.stringify(jumpState),
    );

    // 11. 清理：删种子证据/记录（DB）→ 删除验收表（UI，级联清字段/记录/历史）
    await writeSteMemoryDb(
      page,
      (db, a) => {
        db.transaction("memoryEvidence", "readwrite").objectStore("memoryEvidence").delete(a.evidenceId);
        db.transaction("memoryRecords", "readwrite").objectStore("memoryRecords").delete(a.recordId);
      },
      { evidenceId: seededEvidenceId, recordId: seededRecordId },
    );
    await clickTab(page, "tables");
    await waitUntil(
      page,
      (tid) =>
        !!document.querySelector(`#stm-panel [data-action="delete-table"][data-table-id="${tid}"]`),
      "删除表格按钮就位",
      20000,
      tableId,
    );
    await page.evaluate((tid) => {
      document.querySelector(`#stm-panel [data-action="delete-table"][data-table-id="${tid}"]`)?.click();
    }, tableId);
    await waitForDbState(
      page,
      (db) =>
        !db.tables.some((t) => t.id === tableId) &&
        !db.records.some((r) => r.tableId === tableId) &&
        !db.fields.some((f) => f.tableId === tableId),
      "验收表级联删除",
    );
    const dbAfter = await readSteMemoryDb(page);
    check(
      "清理：验收表/字段/记录/证据全部移除",
      !dbAfter.tables.some((t) => t.key === TEST_TABLE_KEY) &&
        !dbAfter.records.some((r) => r.tableId === tableId) &&
        !dbAfter.fields.some((f) => f.tableId === tableId),
      `tables=${dbAfter.tables.length} records=${dbAfter.records.length}`,
    );

    check("无页面/插件运行时错误", pageErrors.length === 0, pageErrors.join("; "));
  } catch (error) {
    check("脚本执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}（共 ${results.length} 项）`);
  for (const f of failed) console.log(`  FAIL  ${f.name}  — ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
