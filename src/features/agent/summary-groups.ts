import {
  memorySummaryRules,
  type MemoryProposalError,
  type MemoryProposalOperation,
  type MemoryProposalPorts,
  type MemorySpaceId,
} from "../memory/index.ts";
import { findTableInDigest, findFieldInDigest, type MemorySpaceTableDigest } from "./digest.ts";

/** 固定本轮已提交来源；预览与提交使用同一份快照，避免把本批 create 算入门槛。 */
export async function prepareSummaryGroups(
  ports: MemoryProposalPorts,
  spaceId: MemorySpaceId,
  digest: MemorySpaceTableDigest,
): Promise<{
  readonly instructions: string;
  readonly validate: (
    operations: readonly MemoryProposalOperation[],
  ) => readonly MemoryProposalError[];
}> {
  const groups = await Promise.all(
    memorySummaryRules(digest.summaryRules).map(async (rule) => {
      const source = findTableInDigest(digest, rule.sourceTableKey);
      const target = findTableInDigest(digest, rule.targetTableKey);
      const reference = source && findFieldInDigest(source, rule.referenceFieldKey);
      if (
        !source ||
        !target ||
        !reference ||
        reference.type !== "single_reference" ||
        reference.referenceTableKey !== target.key
      ) {
        throw new Error(
          `总结规则引用无效：${rule.sourceTableKey}.${rule.referenceFieldKey} → ${rule.targetTableKey}`,
        );
      }
      const records = (await ports.records.list(spaceId, source.id))
        .filter((record) => record.payload[reference.id] == null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return {
        rule,
        source,
        target,
        reference,
        records,
        ids: records.slice(0, rule.groupSize).map((record) => record.id),
      };
    }),
  );
  return {
    instructions: groups
      .map(({ rule, records, ids }) => {
        const ready = records.length >= rule.groupSize + rule.retainCount;
        return `总结归组 ${rule.sourceTableKey} → ${rule.targetTableKey}：本轮开始前有 ${records.length} 条未归组记录，门槛为 ${rule.groupSize + rule.retainCount}。${
          ready
            ? `本轮应创建一条总结，来源恰为以下 ${rule.groupSize} 条；用 $record_id in 一次查询正文，并逐条更新 ${rule.referenceFieldKey}：${JSON.stringify(ids)}。`
            : "本轮不新建总结；本批新增来源不计入门槛。"
        }`;
      })
      .join("\n"),
    validate(operations) {
      const errors: MemoryProposalError[] = [];
      for (const { rule, source, target, reference, records, ids } of groups) {
        const creates = operations.filter(
          (operation): operation is Extract<MemoryProposalOperation, { type: "create" }> =>
            operation.tableId === target.id && operation.type === "create",
        );
        if (creates.length === 0) continue;
        if (creates.length !== 1) {
          errors.push({
            externalId: creates[0]!.externalId,
            message: `每批最多新建一条 ${target.key} 总结`,
          });
          continue;
        }
        if (records.length < rule.groupSize + rule.retainCount) {
          errors.push({
            externalId: creates[0]!.externalId,
            message: `已保存的未归组 ${source.key} 仅 ${records.length} 条，须达到 ${rule.groupSize + rule.retainCount} 条才能总结；本批新建来源不计入。`,
          });
          continue;
        }
        const summary = creates[0]!;
        const linked = operations.filter(
          (operation) =>
            operation.tableId === source.id &&
            operation.type !== "delete" &&
            operation.patch[reference.id] === summary.tempId,
        );
        const actual = new Set(
          linked.flatMap((operation) => (operation.type === "update" ? [operation.recordId] : [])),
        );
        const expected = new Set(ids);
        const missing = ids.filter((id) => !actual.has(id));
        const unexpected = [...actual].filter((id) => !expected.has(id));
        if (
          linked.some((operation) => operation.type === "create") ||
          missing.length ||
          unexpected.length ||
          actual.size !== rule.groupSize
        ) {
          errors.push({
            externalId: summary.externalId,
            message: `总结来源必须恰为最早 ${rule.groupSize} 条已保存未归组记录；当前关联 ${actual.size} 条。缺少 ${JSON.stringify(missing)}；多选 ${JSON.stringify(unexpected)}；不得关联本批新建记录。`,
          });
        }
      }
      return errors;
    },
  };
}
