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
import type { StRegexEntry } from "../st/st-chat-adapter.ts";
import { CleaningRulesManager, CleaningTestDialog, ImportDialog } from "./cleaning-rules-manager.tsx";
import { runCleaningTest, type CleaningTestRun } from "./cleaning-rules-manager-model.ts";

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
    memoryViews: [],
    entryPlacement: "top",
    ...overrides,
  };
}

function renderManager(overrides: {
  readonly settings?: PluginSettings;
  readonly selectedListId?: string;
  readonly entries?: readonly StRegexEntry[];
} = {}): string {
  return renderToString(
    <CleaningRulesManager
      settings={overrides.settings ?? settings()}
      selectedListId={overrides.selectedListId}
      onSelectList={() => undefined}
      onChange={() => undefined}
      readStRegexEntries={() => overrides.entries ?? []}
      readRecentMessages={() => []}
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

  it("测试按钮：有列表时可用（动作行），无列表时禁用", () => {
    const withList = text(
      renderManager({
        settings: settings({
          cleaningRuleLists: [{ id: "l1", name: "我的清洗", rules: [] }],
        }),
      }),
    );
    expect(withList).toContain('data-action="test-cleaning-list"');
    expect(withList).not.toContain('data-action="test-cleaning-list" disabled=""');
    const withoutList = text(renderManager());
    expect(withoutList).toContain('data-action="test-cleaning-list" disabled=""');
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
        sources={["global"]}
        selected={[0]}
        importableCount={1}
        selectedCount={1}
        target={{ kind: "existing", listId: "l1" }}
        targetListName="我的清洗"
        onToggleCandidate={() => undefined}
        onTargetChange={() => undefined}
        onImportFile={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        {...overrides}
      />,
    );
  }

  it("候选条目只显示来源标签 + 名称；目标 = 当前列表（只读提示）；跳过条目带原因", () => {
    const html = text(renderDialog());
    expect(html).toContain("导入正则");
    expect(html).toContain("全局");
    expect(html).toContain("去粗体");
    // 精简：不显示模式/正则/flags/差异说明
    expect(html).not.toContain("→");
    expect(html).not.toContain("trimStrings");
    expect(html).toContain("跳过「世界书专用」：作用范围不含用户输入/AI 输出");
    expect(html).toContain("导入到：我的清洗");
    expect(html).toContain("导入（1 条）");
    expect(html).toContain('data-action="import-st-regex-file"');
  });

  it("空态：引导在 ST 配置或从文件导入；无列表时显示新建名称输入；无可导入条目时导入按钮禁用", () => {
    const empty = text(renderDialog({ candidates: [], sources: [], importableCount: 0, selectedCount: 0, selected: [] }));
    expect(empty).toContain("ST 中暂无正则条目");
    expect(empty).toContain("从文件导入");

    const newTarget = text(
      renderDialog({ target: { kind: "new", name: "从 ST 导入" }, targetListName: "" }),
    );
    expect(newTarget).toContain('data-stm-field="import-target-name"');
    expect(newTarget).toContain("新建列表名称");

    const skippedOnly = text(
      renderDialog({
        candidates: [{ kind: "skipped", scriptName: "A", reason: "缺匹配式" }],
        sources: ["global"],
        importableCount: 0,
        selectedCount: 0,
        selected: [],
      }),
    );
    expect(skippedOnly).toContain("跳过「A」：缺匹配式");
    expect(skippedOnly).toContain('disabled=""');
  });
});

describe("CleaningTestDialog（清洗测试弹窗冒烟，ticket 27）", () => {
  const rules = [
    { id: "r1", name: "去粗体", mode: "discard" as const, pattern: "\\*\\*", flags: "g", enabled: true },
    { id: "r2", name: "旧停用", mode: "replace" as const, pattern: "x", flags: "g", enabled: false },
  ];

  function renderDialog(overrides: Partial<Parameters<typeof CleaningTestDialog>[0]> = {}): string {
    return renderToString(
      <CleaningTestDialog
        form="text"
        text=""
        messages={[]}
        result={undefined}
        hasDraftOverrides={false}
        loadHint={null}
        onTextChange={() => undefined}
        onMessageChange={() => undefined}
        onLoadMessages={() => undefined}
        onRun={() => undefined}
        onCopy={() => undefined}
        onClose={() => undefined}
        {...overrides}
      />,
    );
  }

  it("单条文本形态：标题 + 文本框 + 载入对话/清洗/复制/关闭，复制在无结果时禁用", () => {
    const html = text(renderDialog());
    expect(html).toContain("清洗测试");
    expect(html).toContain('data-stm-field="cleaning-test-input"');
    expect(html).toContain('data-action="load-chat-messages"');
    expect(html).toContain("从当前对话载入");
    expect(html).toContain('data-action="run-cleaning-test"');
    expect(html).toContain('data-action="copy-cleaning-test" disabled=""');
    expect(html).toContain('data-action="close-cleaning-test"');
    expect(html).not.toContain('data-stm-field="cleaning-test-result"');
  });

  it("消息列表形态：逐条渲染名字与内容输入框", () => {
    const html = text(
      renderDialog({
        form: "messages",
        messages: [
          { name: "爱丽丝", content: "**你好**" },
          { name: "", content: "第二条" },
        ],
      }),
    );
    expect(html).toContain('data-stm-field="cleaning-test-message-name-0"');
    expect(html).toContain('data-stm-field="cleaning-test-message-content-1"');
    expect(html).toContain("爱丽丝");
  });

  it("ok 结果：逐规则步骤（含停用跳过）+ 最终结果；空结果显示（空）", () => {
    const result = runCleaningTest(rules, new Map(), [{ name: "", content: "**a**x" }]);
    const html = text(
      renderDialog({
        result,
      }),
    );
    expect(html).toContain('data-stm-field="cleaning-test-result"');
    expect(html).toContain('data-stm-field="cleaning-test-step-0"');
    expect(html).toContain("去粗体 · 去掉");
    expect(html).toContain("ax");
    expect(html).toContain("跳过（已停用）");
    expect(html).not.toContain('disabled=""');
  });

  it("草稿参与的步骤带「草稿」标记（步骤级标注）", () => {
    const result = runCleaningTest(
      rules,
      new Map([["r1", { name: "草稿改", mode: "keep", pattern: "a", flags: "g", replacement: "", enabled: true }]]),
      [{ name: "", content: "a" }],
    );
    const html = text(renderDialog({ result, hasDraftOverrides: true }));
    expect(html).toContain("草稿改");
    expect(html).toContain("草稿");
    expect(html).toContain("含未保存修改");
  });

  it("空输入运行 → 结果显示（空）", () => {
    const result = runCleaningTest(rules, new Map(), [{ name: "", content: "" }]);
    const html = text(renderDialog({ result }));
    expect(html).toContain("（空）");
  });

  it("草稿校验失败 → 错误展示（不渲染结果区）", () => {
    const result: CleaningTestRun = {
      kind: "error",
      errors: ["规则「草稿规则」：正则表达式语法错误"],
    };
    const html = text(renderDialog({ result, hasDraftOverrides: true }));
    expect(html).toContain('data-stm-field="cleaning-test-error"');
    expect(html).toContain("规则「草稿规则」：正则表达式语法错误");
    expect(html).not.toContain('data-stm-field="cleaning-test-result"');
  });

  it("标注：含未保存修改 + 无启用规则提示 + 载入无消息提示", () => {
    const noActive: CleaningTestRun = {
      kind: "ok",
      anyActiveRule: false,
      messages: [{ name: "", input: "a", steps: [], output: "a" }],
    };
    const html = text(
      renderDialog({ result: noActive, hasDraftOverrides: true, loadHint: "当前对话没有消息" }),
    );
    expect(html).toContain("含未保存修改");
    expect(html).toContain("列表没有启用规则");
    expect(html).toContain("当前对话没有消息");
  });
});
