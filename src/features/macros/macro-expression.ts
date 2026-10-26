import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateMemoryViewName, type MemoryView } from "./memory-views.ts";

export type {
  MemoryMacro,
  MacroExpression,
  MacroQuery,
  MacroQueryInput,
  MacroQueryValue,
  MacroSemanticSource,
} from "../memory/index.ts";
import type { MemoryMacro } from "../memory/index.ts";

const text = Type.String({ minLength: 1 });
const scalarValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const fieldValue = Type.Union([scalarValue, Type.Array(scalarValue)]);
const inputSchema = Type.Union([
  Type.Object({ context: Type.Literal("last_user_message") }, { additionalProperties: false }),
  Type.Object({ text: Type.String() }, { additionalProperties: false }),
]);
const groupsSchema = Type.Array(text, { minItems: 1, uniqueItems: true });
const sourceSchema = Type.Object(
  { name: text, table: text, groups: groupsSchema, query: inputSchema },
  { additionalProperties: false },
);
const querySchema = Type.Object(
  {
    table: text,
    conditions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            field: text,
            op: Type.Enum([
              "equals",
              "not_equals",
              "contains",
              "not_contains",
              "greater_than",
              "greater_than_or_equal",
              "less_than",
              "less_than_or_equal",
              "in",
              "not_in",
            ]),
            value: fieldValue,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    fields: Type.Optional(Type.Array(text, { uniqueItems: true })),
    orderBy: Type.Optional(
      Type.Object(
        { field: text, direction: Type.Enum(["asc", "desc"]) },
        { additionalProperties: false },
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    semantic: Type.Optional(
      Type.Object({ groups: groupsSchema, query: inputSchema }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export const memoryMacroSchema = Type.Object(
  {
    id: text,
    name: text,
    enabled: Type.Boolean(),
    expression: Type.Union([
      Type.Object(
        { language: Type.Literal("query"), query: querySchema },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          language: Type.Literal("sql"),
          sources: Type.Optional(Type.Array(sourceSchema)),
          sql: text,
          usesSemantic: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ]),
    output: Type.Object(
      {
        format: Type.Enum(["text", "markdown", "json"]),
        maxChars: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    legacyRendering: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export function validateMemoryMacro(macro: MemoryMacro): void {
  if (!Value.Check(memoryMacroSchema, macro)) {
    const issue = [...Value.Errors(memoryMacroSchema, macro)][0]!;
    throw new Error(`宏定义无效（${issue.instancePath}）：${issue.message}`);
  }
  const nameError = validateMemoryViewName(macro.name);
  if (nameError) throw new Error(nameError.replaceAll("视图", "宏"));
  const expression = macro.expression;
  if (expression.language === "query") {
    const query = expression.query;
    const fields = [
      ...(query.fields ?? []),
      ...(query.conditions ?? []).map((item) => item.field),
      ...(query.orderBy ? [query.orderBy.field] : []),
    ];
    if (!query.semantic && fields.includes("$similarity"))
      throw new Error("使用 $similarity 需要声明 semantic");
  } else {
    const names = new Set<string>();
    for (const source of expression.sources ?? []) {
      const name = source.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      if (name.startsWith("__") || name.startsWith("sqlite_") || names.has(name))
        throw new Error(`语义源名称重复或使用保留名称：${source.name}`);
      names.add(name);
    }
  }
}

/** 持久化边界严格校验，保留调用方的原始值，不丢弃损坏宏。 */
export function parseMemoryMacros(raw: unknown): readonly MemoryMacro[] {
  if (!Array.isArray(raw)) throw new Error("宏集合必须是数组");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of raw) {
    validateMemoryMacro(value as MemoryMacro);
    const macro = value as MemoryMacro;
    if (ids.has(macro.id) || names.has(macro.name))
      throw new Error(`宏身份或名称重复：${macro.name}`);
    ids.add(macro.id);
    names.add(macro.name);
  }
  return raw as MemoryMacro[];
}

export function hasSemanticSource(macro: MemoryMacro): boolean {
  return macro.expression.language === "query"
    ? macro.expression.query.semantic !== undefined
    : macro.expression.usesSemantic === true || (macro.expression.sources?.length ?? 0) > 0;
}

export function copyMemoryMacros(
  macros: readonly MemoryMacro[],
  createId: () => string,
): MemoryMacro[] {
  return parseMemoryMacros(macros).map((macro) => ({
    ...structuredClone(macro),
    id: createId(),
    enabled: hasSemanticSource(macro) ? false : macro.enabled,
  }));
}

export function migrateMemoryView(view: MemoryView, id: string): MemoryMacro {
  const macro: MemoryMacro = {
    id,
    name: view.name,
    enabled: true,
    expression: {
      language: "query",
      query: {
        table: view.tableKey,
        ...(view.condition
          ? {
              conditions: [
                { field: view.condition.fieldKey, op: "in", value: [...view.condition.values] },
              ],
            }
          : {}),
        ...(view.projection.length ? { fields: [...view.projection] } : {}),
        orderBy: { field: "$updated_at", direction: "desc" },
        limit: view.limit ?? 100,
      },
    },
    output: { format: "text", maxChars: null },
    legacyRendering: true,
  };
  validateMemoryMacro(macro);
  return macro;
}

export function migrateMemoryViews(raw: unknown, identityPrefix: string): readonly MemoryMacro[] {
  const schema = Type.Array(
    Type.Object({
      name: text,
      tableKey: text,
      condition: Type.Optional(
        Type.Union([
          Type.Null(),
          Type.Object({ fieldKey: text, values: Type.Array(Type.String(), { minItems: 1 }) }),
        ]),
      ),
      limit: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: 100 })])),
      projection: Type.Optional(Type.Array(Type.String())),
    }),
  );
  if (!Value.Check(schema, raw)) throw new Error("旧宏定义损坏，原始数据已保留，无法迁移");
  return parseMemoryMacros(
    (raw as MemoryView[]).map((view) =>
      migrateMemoryView(
        {
          ...view,
          condition: view.condition ?? null,
          limit: view.limit ?? null,
          projection: view.projection ?? [],
        },
        `${identityPrefix}:${encodeURIComponent(view.name)}`,
      ),
    ),
  );
}

/** 显式恢复保留身份，语义宏须由用户重新启用。普通镜像加载不调用此操作。 */
export function restoredMemoryMacros(macros: readonly MemoryMacro[]): readonly MemoryMacro[] {
  return parseMemoryMacros(macros).map((macro) => ({
    ...macro,
    enabled: hasSemanticSource(macro) ? false : macro.enabled,
  }));
}

/** 预设结构校验不执行用户 SQL；SQL 的列依赖由隔离读取会话编译校验。 */
export function validateMacroDependencies(
  macros: readonly MemoryMacro[],
  tables: readonly {
    readonly key: string;
    readonly fields: readonly { readonly key: string }[];
    readonly vectorIndex?: { readonly groups: readonly { readonly key: string }[] };
  }[],
): void {
  parseMemoryMacros(macros);
  const tableNames = new Set(
    tables.map((table) => table.key.replace(/[A-Z]/g, (letter) => letter.toLowerCase())),
  );
  for (const macro of macros) {
    const expression = macro.expression;
    const sources =
      expression.language === "query"
        ? [{ table: expression.query.table, groups: expression.query.semantic?.groups ?? [] }]
        : (expression.sources ?? []);
    for (const source of sources) {
      const table = tables.find((candidate) => candidate.key === source.table);
      if (!table) throw new Error(`宏「${macro.name}」引用了不存在的表「${source.table}」`);
      for (const group of source.groups) {
        if (!table.vectorIndex?.groups.some((candidate) => candidate.key === group))
          throw new Error(`宏「${macro.name}」引用了不存在的向量组「${source.table}.${group}」`);
      }
      if (expression.language === "query") {
        const query = expression.query;
        const keys = [
          ...(query.fields ?? []),
          ...(query.conditions ?? []).map((item) => item.field),
          ...(query.orderBy ? [query.orderBy.field] : []),
        ];
        const system = new Set([
          "$record_id",
          "$display_text",
          "$created_at",
          "$updated_at",
          ...(query.semantic ? ["$similarity"] : []),
        ]);
        for (const key of keys) {
          if (!system.has(key) && !table.fields.some((field) => field.key === key))
            throw new Error(`宏「${macro.name}」引用了不存在的字段「${source.table}.${key}」`);
        }
      }
    }
    if (expression.language === "sql") {
      for (const source of expression.sources ?? []) {
        if (tableNames.has(source.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())))
          throw new Error(`语义源与业务表同名：${source.name}`);
      }
    }
  }
}
