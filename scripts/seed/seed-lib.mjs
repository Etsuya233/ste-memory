// 种子机制：数据驱动，供 seed-jp.mjs（日文版）与 seed-zh.mjs（中文版）共用
// 用法：runSeed(data, dbPath?)，data 为 seed-data-*.mjs 导出的数据模块
// 数据库路径：优先取 --db 参数（支持 sqlite: 前缀），否则默认 data/ste-memory.sqlite
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const Database = require("better-sqlite3");

// 解析 --db 参数；未指定时默认仓库根目录 data/ste-memory.sqlite（与应用默认 DATABASE_URL 一致）
function resolveDbPath(argv) {
  const flagIndex = argv.indexOf("--db");
  let raw = null;
  if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined) {
    raw = argv[flagIndex + 1];
  }
  if (raw === null) {
    return path.join(
      path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url))),
      "data",
      "ste-memory.sqlite",
    );
  }
  const value = raw.replace(/^sqlite:/, ""); // 兼容 DATABASE_URL 的 sqlite: 前缀
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

const DB_PATH = resolveDbPath(process.argv.slice(2));
const dbDir = path.dirname(DB_PATH);
if (!existsSync(dbDir)) {
  console.error(`数据库目录不存在: ${dbDir}`);
  process.exit(1);
}

console.log(`数据库: ${DB_PATH}`);

export function runSeed(data) {
  // ---------- 组装记录 ----------
  // 字段符号键（插入时映射为字段 UUID）
  const fk = (tableKey, fieldKey) => `${tableKey}.${fieldKey}`;
  // 显示名从数据派生，避免两版漂移
  const charName = Object.fromEntries(Object.entries(data.CHARS).map(([id, c]) => [id, c[0]]));
  const ts = (date, i) => {
    const [y, m, d] = date.split("-");
    const h = String(8 + (Math.floor(i / 12) % 12)).padStart(2, "0");
    const mi = String((i % 12) * 5).padStart(2, "0");
    return `${y}-${m}-${d}T${h}:${mi}:00.000Z`;
  };
  const uuid = (map, key) => (map[key] ??= randomUUID());
  const charId = (c) => uuid(charUuid, c);
  const locId = (l) => uuid(locUuid, l);
  const itemId = (it) => uuid(itemUuid, it);

  const charUuid = {},
    locUuid = {},
    itemUuid = {};
  const records = []; // {tableKey, id, payload, displayText, createdAt}

  let i = 0;
  for (const [id, c] of Object.entries(data.CHARS)) {
    i += 1;
    const [aliases, role, personality, appearance, background, status, notes] = c;
    records.push({
      tableKey: "characters",
      id: charId(id),
      payload: {
        [fk("characters", "name")]: charName[id],
        [fk("characters", "aliases")]: aliases,
        [fk("characters", "role")]: role,
        [fk("characters", "personality")]: personality,
        [fk("characters", "appearance")]: appearance,
        [fk("characters", "background")]: background,
        [fk("characters", "current_status")]: status,
        [fk("characters", "notes")]: notes,
      },
      displayText: charName[id],
      createdAt: ts("2025-04-01", i),
    });
  }
  i = 0;
  for (const [id, loc] of Object.entries(data.LOCS)) {
    i += 1;
    const [name, type, details, status, chars, items, notes] = loc;
    records.push({
      tableKey: "locations",
      id: locId(id),
      payload: {
        [fk("locations", "name")]: name,
        [fk("locations", "type")]: type,
        [fk("locations", "details")]: details,
        [fk("locations", "current_status")]: status,
        [fk("locations", "related_characters")]: chars.map(charId),
        [fk("locations", "related_items")]: items.map(itemId),
        [fk("locations", "notes")]: notes,
      },
      displayText: name,
      createdAt: ts("2025-04-02", i),
    });
  }
  i = 0;
  for (const [id, item] of Object.entries(data.ITEMS)) {
    i += 1;
    const [name, type, owner, loc, status, attrs, notes] = item;
    records.push({
      tableKey: "items",
      id: itemId(id),
      payload: {
        [fk("items", "name")]: name,
        [fk("items", "type")]: type,
        [fk("items", "owner")]: owner ? charId(owner) : null,
        [fk("items", "current_location")]: loc ? locId(loc) : null,
        [fk("items", "current_status")]: status,
        [fk("items", "key_attributes")]: attrs,
        [fk("items", "notes")]: notes,
      },
      displayText: name,
      createdAt: ts("2025-04-03", i),
    });
  }
  i = 0;
  for (const [a, b, desc, status, facts, notes] of data.RELS) {
    i += 1;
    records.push({
      tableKey: "relationships",
      id: randomUUID(),
      payload: {
        [fk("relationships", "character_a")]: charId(a),
        [fk("relationships", "character_b")]: charId(b),
        [fk("relationships", "description")]: desc,
        [fk("relationships", "current_status")]: status,
        [fk("relationships", "key_facts")]: facts,
        [fk("relationships", "notes")]: notes,
      },
      displayText: `${charName[a]} <-> ${charName[b]}`,
      createdAt: ts("2025-04-04", i),
    });
  }
  i = 0;
  for (const arc of data.PLOT_ARCS) {
    let k = 0;
    for (const [name, status, chars, locs, details, notes, start, end] of arc.list) {
      i += 1;
      k += 1;
      records.push({
        tableKey: "plots",
        id: randomUUID(),
        payload: {
          [fk("plots", "name")]: name,
          [fk("plots", "details")]: details,
          [fk("plots", "related_characters")]: chars.map(charId),
          [fk("plots", "related_locations")]: locs.map(locId),
          [fk("plots", "status")]: status,
          [fk("plots", "start_time")]: start,
          [fk("plots", "end_time")]: end,
          [fk("plots", "notes")]: notes,
        },
        displayText: name,
        createdAt: ts(arc.base, k),
      });
    }
  }
  i = 0;
  for (const [name, status, chars, locs, details, plan, notes] of data.FORESHADOWING) {
    i += 1;
    records.push({
      tableKey: "foreshadowing",
      id: randomUUID(),
      payload: {
        [fk("foreshadowing", "name")]: name,
        [fk("foreshadowing", "details")]: details,
        [fk("foreshadowing", "related_characters")]: chars.map(charId),
        [fk("foreshadowing", "related_locations")]: locs.map(locId),
        [fk("foreshadowing", "status")]: status,
        [fk("foreshadowing", "resolution_plan")]: plan,
        [fk("foreshadowing", "notes")]: notes,
      },
      displayText: name,
      createdAt: ts("2025-09-10", i),
    });
  }
  i = 0;
  for (const [name, details, chars, locs, priority, status, due, notes] of data.TODOS) {
    i += 1;
    records.push({
      tableKey: "todos",
      id: randomUUID(),
      payload: {
        [fk("todos", "name")]: name,
        [fk("todos", "details")]: details,
        [fk("todos", "related_characters")]: chars.map(charId),
        [fk("todos", "related_locations")]: locs.map(locId),
        [fk("todos", "priority")]: priority,
        [fk("todos", "status")]: status,
        [fk("todos", "due_date")]: due,
        [fk("todos", "notes")]: notes,
      },
      displayText: name,
      createdAt: ts("2025-04-06", i),
    });
  }

  // ---------- 入库 ----------
  function run() {
    const db = new Database(DB_PATH);
    db.pragma("foreign_keys = ON");
    const now = new Date().toISOString();
    const spaceId = randomUUID();

    // 1. 建表（与迁移一致，幂等）
    db.exec(SCHEMA);

    // 2. 幂等：删除同名空间（外键级联）
    const del = db.prepare("DELETE FROM memory_spaces WHERE name = ?");
    const delCount = del.run(data.SPACE_NAME).changes;
    if (delCount > 0) console.log(`已删除同名旧空间（${delCount} 个）`);

    // 3. 空间 + 系统表 + 字段（全部随机 UUID）
    const insertSpace = db.prepare(
      "INSERT INTO memory_spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    insertSpace.run(spaceId, data.SPACE_NAME, now, now);

    const insertTable = db.prepare(
      `INSERT INTO memory_tables (id, memory_space_id, key, kind, name, description, prompt, enabled, display_strategy, created_at, updated_at)
     VALUES (?, ?, ?, 'system', ?, ?, ?, 1, ?, ?, ?)`,
    );
    const insertField = db.prepare(
      `INSERT INTO memory_fields (id, memory_space_id, table_id, key, name, type, required, prompt, enabled, position, options_json, reference_table_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );

    const tableIdByKey = {};
    const fieldIdByKey = {}; // tableKey -> fieldKey -> uuid
    for (const t of data.TPL) {
      const tableId = randomUUID();
      tableIdByKey[t.key] = tableId;
      fieldIdByKey[t.key] = {};
      const ds =
        t.key === "relationships"
          ? JSON.stringify({ type: "template", template: `{PLACEHOLDER_A} <-> {PLACEHOLDER_B}` })
          : null; // 占位，字段生成后修正
      insertTable.run(tableId, spaceId, t.key, t.name, t.desc, t.prompt, ds, now, now);
      t.fields.forEach(([key, name, type, required, prompt, options, ref], pos) => {
        const fieldId = randomUUID();
        fieldIdByKey[t.key][key] = fieldId;
        insertField.run(
          fieldId,
          spaceId,
          tableId,
          key,
          name,
          type,
          required,
          prompt,
          pos,
          JSON.stringify(options),
          ref ? tableIdByKey[ref] : null,
          now,
          now,
        );
      });
    }
    // 修正显示策略（引用字段 UUID）
    const relA = fieldIdByKey.relationships.character_a;
    const relB = fieldIdByKey.relationships.character_b;
    const updateDs = db.prepare("UPDATE memory_tables SET display_strategy = ? WHERE id = ?");
    for (const t of data.TPL) {
      if (t.key === "relationships") {
        updateDs.run(
          JSON.stringify({ type: "template", template: `{${relA}} <-> {${relB}}` }),
          tableIdByKey.relationships,
        );
      } else {
        updateDs.run(
          JSON.stringify({ type: "field", fieldId: fieldIdByKey[t.key][t.fields[0][0]] }),
          tableIdByKey[t.key],
        );
      }
    }

    // 4. 记录（随机 UUID；载荷键 = 字段 UUID；引用值 = 记录 UUID）
    const insertRecord = db.prepare(
      `INSERT INTO memory_records (id, memory_space_id, table_id, payload_json, field_evidence_json, display_text, source_json, revision_id, revision_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?, 'agent', ?, ?)`,
    );
    const sourceJson = JSON.stringify({ type: "source", sourceTime: null, sourceLocation: null });
    const insertAll = db.transaction(() => {
      for (const r of records) {
        const payload = Object.fromEntries(
          Object.entries(r.payload).map(([k, v]) => {
            const [tk, fkKey] = k.split(".");
            return [fieldIdByKey[tk][fkKey], v];
          }),
        );
        insertRecord.run(
          r.id,
          spaceId,
          tableIdByKey[r.tableKey],
          JSON.stringify(payload),
          r.displayText,
          sourceJson,
          randomUUID(),
          r.createdAt,
          r.createdAt,
        );
      }
    });
    insertAll();

    // 5. 自校验
    const errors = verify(db, spaceId, tableIdByKey);
    if (errors.length > 0) {
      console.error("校验失败：");
      for (const e of errors) console.error("  - " + e);
      process.exitCode = 1;
    }
    const counts = {};
    for (const r of records) counts[r.tableKey] = (counts[r.tableKey] ?? 0) + 1;
    console.log("✔ 已写入记忆空间:", data.SPACE_NAME);
    console.log("  空间 UUID:", spaceId);
    console.log("  各表记录数:", counts, "总计:", records.length);
    console.log("  剧情纪要:", counts.plots, "条（要求 >= 100）");
    db.close();
  }

  function verify(db, spaceId, tableIdByKey) {
    const errors = [];
    // 引用完整性
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length > 0) errors.push(`外键违规 ${JSON.stringify(fk)}`);
    // 各表记录数
    const countStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM memory_records WHERE memory_space_id = ? AND table_id = ?",
    );
    const expected = data.EXPECTED;
    for (const [key, want] of Object.entries(expected)) {
      const got = countStmt.get(spaceId, tableIdByKey[key]).n;
      if (got !== want) errors.push(`${key}: 期望 ${want} 条，实际 ${got} 条`);
    }
    if (countStmt.get(spaceId, tableIdByKey.plots).n < 100) errors.push("剧情纪要不足 100 条");
    // 引用字段的值必须指向目标表存在的记录
    const refFields = db
      .prepare(
        `SELECT f.id AS field_id, f.reference_table_id AS ref_table, f.table_id AS field_table_id
     FROM memory_fields f
     WHERE f.memory_space_id = ? AND f.reference_table_id IS NOT NULL`,
      )
      .all(spaceId);
    const recIdByTable = new Map();
    for (const r of db
      .prepare("SELECT id, table_id FROM memory_records WHERE memory_space_id = ?")
      .all(spaceId)) {
      (recIdByTable.get(r.table_id) ?? recIdByTable.set(r.table_id, new Set()).get(r.table_id)).add(
        r.id,
      );
    }
    const allRecs = db
      .prepare("SELECT id, table_id, payload_json FROM memory_records WHERE memory_space_id = ?")
      .all(spaceId);
    for (const r of allRecs) {
      const payload = JSON.parse(r.payload_json);
      for (const rf of refFields) {
        if (rf.field_table_id !== r.table_id) continue;
        const val = payload[rf.field_id];
        if (val === undefined || val === null) continue;
        const targets = Array.isArray(val) ? val : [val];
        const targetIds = recIdByTable.get(rf.ref_table) ?? new Set();
        for (const t of targets) {
          if (!targetIds.has(t))
            errors.push(`记录 ${r.id} 字段 ${rf.field_id} 引用不存在的记录 ${t}`);
        }
      }
    }
    // 显示文本与策略一致
    const tables = db
      .prepare("SELECT id, key, display_strategy FROM memory_tables WHERE memory_space_id = ?")
      .all(spaceId);
    const nameByRec = new Map();
    for (const r of db
      .prepare("SELECT id, display_text FROM memory_records WHERE memory_space_id = ?")
      .all(spaceId)) {
      nameByRec.set(r.id, r.display_text);
    }
    for (const t of tables) {
      const ds = JSON.parse(t.display_strategy);
      const recs = db
        .prepare(
          "SELECT id, payload_json, display_text FROM memory_records WHERE memory_space_id = ? AND table_id = ?",
        )
        .all(spaceId, t.id);
      for (const r of recs) {
        const payload = JSON.parse(r.payload_json);
        if (ds.type === "field") {
          const want = String(payload[ds.fieldId] ?? "");
          if (r.display_text !== want)
            errors.push(`${t.key}/${r.id}: display_text 应为 "${want}"，实际 "${r.display_text}"`);
        } else {
          const m = ds.template.matchAll(/\{([^{}]+)\}/g);
          let want = ds.template;
          for (const [full, fid] of m) {
            const refId = payload[fid];
            want = want.replaceAll(full, nameByRec.get(refId) ?? `?${refId}`);
          }
          if (r.display_text !== want)
            errors.push(`${t.key}/${r.id}: display_text 应为 "${want}"，实际 "${r.display_text}"`);
        }
      }
    }
    // 枚举字段值必须在选项内
    const selFields = db
      .prepare(
        "SELECT id, options_json, table_id, key FROM memory_fields WHERE memory_space_id = ? AND type = 'single_select'",
      )
      .all(spaceId);
    for (const f of selFields) {
      const opts = JSON.parse(f.options_json);
      for (const r of db
        .prepare(
          "SELECT id, payload_json FROM memory_records WHERE memory_space_id = ? AND table_id = ?",
        )
        .all(spaceId, f.table_id)) {
        const v = JSON.parse(r.payload_json)[f.id];
        if (v !== undefined && v !== null && !opts.includes(v))
          errors.push(`${f.key}/${r.id}: 枚举值 "${v}" 不在选项内`);
      }
    }
    return errors;
  }

  // ---------- Schema（与迁移 0001/0002 一致） ----------
  const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memory_tables (
  id TEXT PRIMARY KEY, memory_space_id TEXT NOT NULL, key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('custom','system')), name TEXT NOT NULL,
  description TEXT NOT NULL, prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), display_strategy TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  UNIQUE (memory_space_id, key)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_fields (
  id TEXT PRIMARY KEY, memory_space_id TEXT NOT NULL, table_id TEXT NOT NULL, key TEXT NOT NULL,
  name TEXT NOT NULL, type TEXT NOT NULL, required INTEGER NOT NULL CHECK (required IN (0,1)),
  prompt TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  options_json TEXT NOT NULL CHECK (json_valid(options_json)), reference_table_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE,
  FOREIGN KEY (reference_table_id) REFERENCES memory_tables(id) ON DELETE RESTRICT,
  UNIQUE (memory_space_id, table_id, key)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY, memory_space_id TEXT NOT NULL, table_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  field_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_evidence_json)),
  display_text TEXT NOT NULL, source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  revision_id TEXT NOT NULL,
  revision_source TEXT NOT NULL CHECK (revision_source IN ('agent','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS memory_record_history (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL, memory_space_id TEXT NOT NULL, table_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  field_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_evidence_json)),
  display_text TEXT NOT NULL, source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  previous_revision_id TEXT NOT NULL,
  previous_revision_source TEXT NOT NULL CHECK (previous_revision_source IN ('agent','user')),
  revision_id TEXT NOT NULL,
  revision_source TEXT NOT NULL CHECK (revision_source IN ('agent','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_space_id TEXT NOT NULL, evidence_id TEXT PRIMARY KEY, source_type TEXT NOT NULL,
  source_id_json TEXT NOT NULL CHECK (json_valid(source_id_json)),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('snapshot','reference')),
  content TEXT, extra_props_json TEXT NOT NULL CHECK (json_valid(extra_props_json)),
  CHECK ((storage_mode = 'snapshot' AND content IS NOT NULL) OR (storage_mode = 'reference' AND content IS NULL)),
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
  UNIQUE (memory_space_id, source_type, source_id_json)
) STRICT;
CREATE TABLE IF NOT EXISTS source_store_chats (
  memory_space_id TEXT PRIMARY KEY, source_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)), created_at TEXT NOT NULL,
  FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS source_store_messages (
  memory_space_id TEXT NOT NULL, source_id INTEGER NOT NULL CHECK (source_id > 0),
  content TEXT NOT NULL, extra_props_json TEXT NOT NULL CHECK (json_valid(extra_props_json)),
  PRIMARY KEY (memory_space_id, source_id),
  FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS source_store_parse_errors (
  memory_space_id TEXT NOT NULL, line_number INTEGER NOT NULL CHECK (line_number > 0),
  raw_line TEXT NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY (memory_space_id, line_number),
  FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS memory_tables_space_id ON memory_tables(memory_space_id, id);
CREATE INDEX IF NOT EXISTS memory_fields_table_id ON memory_fields(memory_space_id, table_id, position, id);
CREATE INDEX IF NOT EXISTS memory_records_table_id ON memory_records(memory_space_id, table_id, created_at, id);
CREATE INDEX IF NOT EXISTS memory_record_history_filters ON memory_record_history(memory_space_id, table_id, record_id, revision_id, archived_at);
`;

  run();
}
