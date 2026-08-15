/**
 * 清洗规则管理器冒烟测试（react-dom/server renderToString，无 jsdom）：
 * 验证渲染契约（data-action / data-stm-field）与关键态（空列表、规则行折叠/
 * 展开含替换串、导入对话框候选/目标/报告）。交互逻辑在
 * cleaning-rules-manager-model / cleaning-rule-lists / st-regex-import 测试覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { StRegexImportItem } from "../settings/st-regex-import.ts";
import { CleaningRulesManager, ImportDialog } from "./cleaning-rules-manager.tsx";

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    enabled: true,
    r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" },
    macroName: "{{memoryContext}}",
    macroLimit: 2000,
    mirror: { enabled: true, includeHistory: true },
    agentPresets: { presets: [], activePresetId: "builtin" },
    agentConnections: [],
    fillTaskConnectionId: undefined,
    queryChatConnectionId: undefined,
    cleaningRuleLists: [],
    ...overrides,
  };
}

function renderManager(overrides: {
  readonly settings?: PluginSettings;
  readonly selectedListId?: string;
  readonly scripts?: readonly unknown[];
} = {}): string {
  return renderToString(
    <CleaningRulesManager
      settings={overrides.settings ?? settings()}
      selectedListId={overrides.selectedListId}
      onSelectList={() => undefined}
      onChange={() => undefined}
      readStRegexScripts={() => overrides.scripts ?? []}
    />,
  );
}

/** renderToString 在相邻文本节点间插入 <!-- --> 分隔注释；剥离后断言可读。 */
function text(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

describe("CleaningRulesManager（清洗规则设置区块冒烟，ticket 22）", () => {
  it("标题 + 当前对话选择（未启用）+ 列表管理按钮 + 空状态就位", () => {
    const html = renderManager();
    expect(html).toContain("清洗规则");
    expect(html).toContain('data-stm-field="chat-cleaning-list"');
    expect(html).toContain("未启用清洗");
    expect(html).toContain('data-action="create-cleaning-list"');
    expect(html).toContain('data-action="import-st-regex"');
    expect(html).toContain('data-action="import-st-regex-file"');
    expect(html).toContain("还没有清洗规则列表");
  });

  it("有列表：选择行列出全部列表，规则行渲染（名称/模式/正则），编辑目标默认跟随选择", () => {
    const html = text(
      renderManager({
        settings: settings({
          cleaningRuleLists: [
            {
              id: "l1",
              name: "我的清洗",
              rules: [
                { id: "r1", name: "去粗体", mode: "discard", pattern: "\\*\\*", flags: "g", enabled: true },
                { id: "r2", name: "提取", mode: "keep", pattern: "(.+)", flags: "g", enabled: false },
              ],
            },
          ],
        }),
        selectedListId: "l1",
      }),
    );
    expect(html).toContain("我的清洗");
    expect(html).toContain("去粗体 · 去掉");
    expect(html).toContain("提取 · 保留");
    expect(html).toContain('data-action="add-cleaning-rule"');
    expect(html).toContain('data-action="edit-cleaning-rule"');
  });

  it("替换模式的规则行摘要显示替换串", () => {
    const html = text(
      renderManager({
        settings: settings({
          cleaningRuleLists: [
            {
              id: "l1",
              name: "替换列表",
              rules: [
                {
                  id: "r1",
                  name: "邮箱",
                  mode: "replace",
                  pattern: "(\\w+)@(\\w+)",
                  flags: "g",
                  replacement: "$2 的 $1",
                  enabled: true,
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(html).toContain("邮箱 · 替换「$2 的 $1」");
  });
});

describe("ImportDialog（导入对话框冒烟）", () => {
  const candidates: readonly StRegexImportItem[] = [
    {
      kind: "rule",
      rule: {
        id: "i1",
        name: "去粗体",
        mode: "discard",
        pattern: "\\*\\*",
        flags: "g",
        enabled: true,
      },
      notes: ["trimStrings（2 项）未迁移"],
    },
    { kind: "skipped", scriptName: "世界书专用", reason: "作用范围不含用户输入/AI 输出" },
  ];

  function renderDialog(overrides: Partial<Parameters<typeof ImportDialog>[0]> = {}): string {
    return renderToString(
      <ImportDialog
        candidates={candidates}
        selected={[0]}
        importableCount={1}
        selectedCount={1}
        lists={[{ id: "l1", name: "我的清洗", rules: [] }]}
        target={{ kind: "existing", listId: "l1" }}
        onToggleCandidate={() => undefined}
        onTargetChange={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        {...overrides}
      />,
    );
  }

  it("候选条目（含差异说明）+ 被跳过条目原因 + 目标列表下拉 + 导入按钮计数", () => {
    const html = text(renderDialog());
    expect(html).toContain("从 ST 正则导入");
    expect(html).toContain("去粗体 → 去掉");
    expect(html).toContain("trimStrings（2 项）未迁移");
    expect(html).toContain("跳过「世界书专用」：作用范围不含用户输入/AI 输出");
    expect(html).toContain('data-stm-field="import-target-list"');
    expect(html).toContain("导入（1 条）");
  });

  it("新建目标：显示列表名输入；无可导入条目：逐条原因且导入按钮禁用", () => {
    const newTarget = text(renderDialog({ target: { kind: "new", name: "从 ST 导入" } }));
    expect(newTarget).toContain('data-stm-field="import-target-name"');

    const empty = text(
      renderDialog({
        candidates: [{ kind: "skipped", scriptName: "A", reason: "缺匹配式" }],
        importableCount: 0,
        selectedCount: 0,
        selected: [],
      }),
    );
    expect(empty).toContain("跳过「A」：缺匹配式");
    expect(empty).toContain('disabled=""');
  });
});
