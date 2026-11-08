import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MemorySpaceReader } from "../../../memory/index.ts";
import { findFieldInDigest, findTableInDigest, type MemorySpaceTableDigest } from "../../digest.ts";
import type { MutateToolParams } from "./mutate-tool.ts";
import type { ProposalState } from "./proposal-state.ts";
import { ProposalToolError } from "./proposal-tool-error.ts";

export const EDIT_TEXT_TOOL_NAME = "edit_text";

const target = {
  table: Type.String(),
  recordId: Type.String(),
  expectedRevisionId: Type.String(),
  field: Type.String(),
};
const parameters = Type.Object(
  {
    ...target,
    op: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
    text: Type.Optional(Type.String({ minLength: 1 })),
    oldText: Type.Optional(Type.String({ minLength: 1 })),
    newText: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    anyOf: [
      Type.Object({ ...target, op: Type.Literal("append"), text: Type.String({ minLength: 1 }) }),
      Type.Object({
        ...target,
        op: Type.Literal("replace"),
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
      }),
    ],
  },
);

export type EditTextToolParams = Static<typeof parameters>;

interface EditTextWriteResult {
  readonly revisionId?: string;
  readonly mutationId?: string;
}

export interface EditTextToolDependencies {
  readonly digest: MemorySpaceTableDigest;
  readonly reader: MemorySpaceReader;
  /** 提案模式叠加尚未提交的字段修改；事务模式直接读取任务视图。 */
  readonly state?: ProposalState;
  readonly update: (id: string, params: MutateToolParams) => Promise<EditTextWriteResult>;
}

export function createEditTextTool(
  deps: EditTextToolDependencies,
): AgentTool<
  typeof parameters,
  EditTextWriteResult & { recordId: string; field: string; value: string; length: number }
> {
  return {
    name: EDIT_TEXT_TOOL_NAME,
    label: "追加或局部替换文本",
    description: [
      "编辑已有记录的 short_text/long_text 字段，沿用 mutate 的校验、证据、修订与事务/提案边界。",
      "table、field 使用 key；recordId、expectedRevisionId 使用查询结果中的最新值。",
      "append 提供 text：非空旧值后以一个换行分隔追加，空字段直接写入 text，保留全部原文。",
      "replace 提供 oldText、newText：oldText 必须非空且在当前字段中精确、唯一匹配，只替换该片段；newText 可为空以删除该片段。匹配失败请重新读取。",
      "先读取经历旧值判断重要性与重复；重要新增优先 append，纠错、压缩或关系态度变化优先局部 replace。",
      "超长时本次编辑失败，原值保留；先压缩重复和过程，保护关键旧事实，再追加。不会自动截断或去重。",
      "返回完整新字段值、length，以及事务模式的最新 revisionId 或提案模式的 mutationId。",
    ].join("\n"),
    parameters,
    executionMode: "sequential",
    async execute(id, params) {
      const table = findTableInDigest(deps.digest, params.table);
      if (!table) throw new ProposalToolError(`表 key「${params.table}」不存在或未启用`);
      const field = findFieldInDigest(table, params.field);
      if (!field || (field.type !== "short_text" && field.type !== "long_text")) {
        throw new ProposalToolError(
          `字段「${params.field}」必须是已启用的 short_text 或 long_text`,
        );
      }
      const page = await deps.reader.queryRecords(deps.digest.memorySpaceId, {
        tableId: table.id,
        fieldIds: [field.id],
        conditions: [{ fieldId: "$record_id", operator: "equals", value: params.recordId }],
        paging: { page: 1, pageSize: 1 },
      });
      const record = page.records[0];
      if (!record) throw new ProposalToolError(`记录 ${params.recordId} 不存在`);
      if (record.revisionId !== params.expectedRevisionId) {
        throw new ProposalToolError("记录修订已变化，请重新查询最新 revisionId 后编辑");
      }
      const pending = deps.state?.operations.find(
        (operation) =>
          operation.tableKey === params.table && operation.recordId === params.recordId,
      );
      if (pending?.op === "delete")
        throw new ProposalToolError("该记录已在提案中删除，不能编辑文本");
      const current =
        pending && Object.hasOwn(pending.patch, params.field)
          ? pending.patch[params.field]
          : record.payload[field.id];
      const previous = current == null ? "" : (current as string);
      let value: string;
      if (params.op === "append") {
        if (!params.text) throw new ProposalToolError("append 需要非空 text");
        value = previous.length > 0 ? `${previous}\n${params.text}` : params.text;
      } else {
        if (!params.oldText || params.newText === undefined) {
          throw new ProposalToolError("replace 需要非空 oldText 与 newText");
        }
        const start = previous.indexOf(params.oldText);
        if (start < 0 || previous.indexOf(params.oldText, start + 1) >= 0) {
          throw new ProposalToolError("oldText 必须在当前字段中精确且唯一匹配，请重新读取后编辑");
        }
        value =
          previous.slice(0, start) + params.newText + previous.slice(start + params.oldText.length);
      }
      // 文本操作只计算新值，统一写入路径负责长度、格式、引用和修订校验。
      const written = await deps.update(id, {
        op: "update",
        table: params.table,
        recordId: params.recordId,
        expectedRevisionId: params.expectedRevisionId,
        patch: { [params.field]: value },
      });
      const details = {
        ...written,
        recordId: params.recordId,
        field: params.field,
        value,
        length: value.length,
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
}
