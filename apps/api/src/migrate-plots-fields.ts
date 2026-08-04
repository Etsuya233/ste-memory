import { randomUUID } from "node:crypto";
import {
  MemoryFieldService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldUseCases,
  type MemorySpaceId,
  type MemorySpaceUseCases,
  type MemoryTableId,
  type MemoryTableUseCases,
} from "@ste-memory/core/memory";
import { loadConfig } from "./config.ts";
import { DatabaseContext } from "./adapters/outbound/sqlite/database/database-context.ts";
import { createDatabase } from "./adapters/outbound/sqlite/database/database.ts";
import { KyselyUnitOfWork } from "./adapters/outbound/sqlite/database/kysely-unit-of-work.ts";
import { KyselyMemoryFieldRepository } from "./adapters/outbound/sqlite/memory/memory-field-repository.ts";
import { KyselyMemorySpaceRepository } from "./adapters/outbound/sqlite/memory/memory-space-repository.ts";
import { KyselyMemoryTableRepository } from "./adapters/outbound/sqlite/memory/memory-table-repository.ts";
import { SYSTEM_TABLE_TEMPLATES } from "./application/system-memory/system-memory-table-definitions.ts";

/**
 * 一次性数据迁移：为存量记忆空间的 plots 表补充 start_time / end_time 字段。
 *
 * - 与创建空间时 SystemMemoryTableInstaller 使用同一份模板，保证新旧空间 schema 一致；
 * - 幂等：字段已存在（按 key 判定）时跳过，可安全重复执行；
 * - 新字段插入在 status 之后（与模板顺序一致），后续字段位置顺延；
 *   用户自定义字段保持在原相对位置，不被重排。
 */

type PlotsFieldTemplate = (typeof SYSTEM_TABLE_TEMPLATES)[number]["fields"][number];

type OrderedItem =
  | { readonly kind: "field"; readonly field: MemoryField }
  | { readonly kind: "template"; readonly template: PlotsFieldTemplate };

export interface PlotsFieldsMigrationResult {
  readonly spacesChecked: number;
  readonly spacesAlreadyMigrated: number;
  readonly spacesWithoutPlotsTable: number;
  readonly fieldsAdded: number;
  readonly fieldsRenumbered: number;
}

const PLOTS_TABLE_KEY = "plots";

export async function migratePlotsFields(
  spaces: MemorySpaceUseCases,
  tables: MemoryTableUseCases,
  fields: MemoryFieldUseCases,
  log: (message: string) => void = console.log,
): Promise<PlotsFieldsMigrationResult> {
  const plotsTemplate = SYSTEM_TABLE_TEMPLATES.find(
    (template) => template.key === PLOTS_TABLE_KEY,
  )!;
  const spaceList = await spaces.list();
  let spacesAlreadyMigrated = 0;
  let spacesWithoutPlotsTable = 0;
  let fieldsAdded = 0;
  let fieldsRenumbered = 0;

  for (const space of spaceList) {
    const perSpace = await migratePlotsFieldsInSpace(
      space.id,
      space.name,
      plotsTemplate.fields,
      tables,
      fields,
      log,
    );
    spacesAlreadyMigrated += perSpace.alreadyMigrated ? 1 : 0;
    spacesWithoutPlotsTable += perSpace.withoutPlotsTable ? 1 : 0;
    fieldsAdded += perSpace.fieldsAdded;
    fieldsRenumbered += perSpace.fieldsRenumbered;
  }
  return {
    spacesChecked: spaceList.length,
    spacesAlreadyMigrated,
    spacesWithoutPlotsTable,
    fieldsAdded,
    fieldsRenumbered,
  };
}

interface SpaceMigrationResult {
  readonly alreadyMigrated: boolean;
  readonly withoutPlotsTable: boolean;
  readonly fieldsAdded: number;
  readonly fieldsRenumbered: number;
}

async function migratePlotsFieldsInSpace(
  spaceId: MemorySpaceId,
  spaceName: string,
  templates: readonly PlotsFieldTemplate[],
  tables: MemoryTableUseCases,
  fields: MemoryFieldUseCases,
  log: (message: string) => void,
): Promise<SpaceMigrationResult> {
  const table = (await tables.list(spaceId)).find((candidate) => candidate.key === PLOTS_TABLE_KEY);
  if (!table) {
    log(`跳过空间「${spaceName}」：没有 plots 表`);
    return { alreadyMigrated: false, withoutPlotsTable: true, fieldsAdded: 0, fieldsRenumbered: 0 };
  }

  const existing = await fields.list(spaceId, table.id);
  const missing = templates.filter(
    (template) => !existing.some((field) => field.key === template.key),
  );
  if (missing.length === 0) {
    log(`跳过空间「${spaceName}」：plots 表已包含全部模板字段`);
    return { alreadyMigrated: true, withoutPlotsTable: false, fieldsAdded: 0, fieldsRenumbered: 0 };
  }

  const ordered = buildOrderedItems(existing, templates, missing);
  let fieldsAdded = 0;
  let fieldsRenumbered = 0;
  for (const [position, item] of ordered.entries()) {
    if (item.kind === "template") {
      const template = item.template;
      await fields.create(spaceId, table.id, {
        key: template.key,
        name: template.name,
        type: template.type,
        required: template.required,
        prompt: template.prompt,
        enabled: true,
        position,
      });
      fieldsAdded += 1;
    } else if (item.field.position !== position) {
      await fields.update(spaceId, table.id, item.field.id, { position });
      fieldsRenumbered += 1;
    }
  }
  log(
    `空间「${spaceName}」：新增字段 ${missing.map((template) => template.key).join("、")}` +
      (fieldsRenumbered > 0 ? `，重排 ${fieldsRenumbered} 个既有字段位置` : ""),
  );
  return { alreadyMigrated: false, withoutPlotsTable: false, fieldsAdded, fieldsRenumbered };
}

/** 把缺失的模板字段按模板顺序插入既有字段列表；每个缺失字段锚定在模板中位于它之前的最后一个字段之后。 */
function buildOrderedItems(
  existing: readonly MemoryField[],
  templates: readonly PlotsFieldTemplate[],
  missing: readonly PlotsFieldTemplate[],
): OrderedItem[] {
  const canonicalIndex = new Map(templates.map((template, index) => [template.key, index]));
  const items: OrderedItem[] = existing.map((field) => ({ kind: "field", field }));
  for (const template of missing) {
    const templateIndex = canonicalIndex.get(template.key)!;
    let insertAt = items.length;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      const key = item.kind === "field" ? item.field.key : item.template.key;
      const index = canonicalIndex.get(key);
      if (index !== undefined && index < templateIndex) {
        insertAt = i + 1;
        break;
      }
    }
    items.splice(insertAt, 0, { kind: "template", template });
  }
  return items;
}

export async function runPlotsFieldsMigration(environment: NodeJS.ProcessEnv): Promise<void> {
  const database = createDatabase(loadConfig(environment).databaseUrl);
  try {
    const context = new DatabaseContext(database);
    const unitOfWork = new KyselyUnitOfWork(database, context);
    const memorySpaceRepository = new KyselyMemorySpaceRepository(context);
    const memoryTableRepository = new KyselyMemoryTableRepository(context);
    const memoryFieldRepository = new KyselyMemoryFieldRepository(context);
    const createId = () => randomUUID();
    const now = () => new Date().toISOString();
    const result = await unitOfWork.run(() =>
      migratePlotsFields(
        new MemorySpaceService(memorySpaceRepository, createId as () => MemorySpaceId, now),
        new MemoryTableService(
          memorySpaceRepository,
          memoryTableRepository,
          createId as () => MemoryTableId,
          now,
        ),
        new MemoryFieldService(
          memoryTableRepository,
          memoryFieldRepository,
          createId as () => MemoryFieldId,
          now,
        ),
      ),
    );
    console.log(`plots 时间字段迁移完成：${JSON.stringify(result)}`);
  } finally {
    await database.destroy();
  }
}

if (import.meta.main) await runPlotsFieldsMigration(process.env);
