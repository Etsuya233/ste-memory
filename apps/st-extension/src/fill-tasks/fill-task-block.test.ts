import { describe, expect, it } from "vitest";
import { buildBlockEvidence, composeBlockPrompt } from "./fill-task-block.ts";
import type { FillSourceMessage } from "./fill-task.ts";
import type { MemoryEvidence, MemoryEvidenceId, MemorySpaceId } from "@ste-memory/core/memory";

const SPACE = "space-a" as MemorySpaceId;
const EVIDENCE_SOURCE_TYPE = "sync_floor";

function messages(...floors: readonly number[]): readonly FillSourceMessage[] {
  return floors.map((floor) => ({
    floor,
    content: floor === 2 ? "[reg] 原始内容 **带标记**" : `消息 ${floor}`,
    name: floor % 2 === 0 ? "爱丽丝" : "鲍勃",
  }));
}

describe("buildBlockEvidence（块证据：reference 模式，复用既有行）", () => {
  it("首次处理的楼层新建证据；已注册的来源复用既有行", async () => {
    const existing: MemoryEvidence = {
      evidence_id: "evidence-1" as MemoryEvidenceId,
      source_type: EVIDENCE_SOURCE_TYPE,
      source_id: 1,
      storage_mode: "reference",
      extraProps: {},
    };
    const findExisting = async (_space: MemorySpaceId, _type: string, sourceId: string | number) =>
      sourceId === 1 ? existing : undefined;

    const evidence = await buildBlockEvidence(
      findExisting,
      () => "new-id" as MemoryEvidenceId,
      SPACE,
      messages(1, 2, 3),
    );

    // 楼层 1 复用既有证据行，2/3 新建（reference 模式，不复制内容）
    expect(evidence).toEqual([
      {
        evidence_id: "new-id",
        source_type: EVIDENCE_SOURCE_TYPE,
        source_id: 2,
        storage_mode: "reference",
        extraProps: {},
      },
      {
        evidence_id: "new-id",
        source_type: EVIDENCE_SOURCE_TYPE,
        source_id: 3,
        storage_mode: "reference",
        extraProps: {},
      },
    ]);
  });
});

describe("composeBlockPrompt（块提示词：任务输入 = 原始消息内容）", () => {
  it("按楼层升序列出消息与发送者名，标注闭区间与条数；内容原样（不套清洗规则）", () => {
    const prompt = composeBlockPrompt(2, 4, messages(2, 3, 4));

    expect(prompt).toContain("消息 2 到 4，共 3 条");
    expect(prompt).toContain("[2] 爱丽丝：[reg] 原始内容 **带标记**");
    expect(prompt).toContain("[3] 鲍勃：消息 3");
    expect(prompt).toContain("[4] 爱丽丝：消息 4");
    // 原文保留格式化标记：ST Regex 由用户自行负责，任务输入不套清洗规则
    expect(prompt).toContain("**带标记**");
    expect(prompt).toContain("请依据这些消息更新记忆表格");
  });
});
