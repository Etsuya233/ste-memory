import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../features/settings/plugin-settings.ts";
import {
  CleaningRulesManager,
  CleaningRuleEditor,
  CleaningTestDialog,
} from "./cleaning-rules-manager.tsx";
import { runCleaningTest } from "./cleaning-rules-manager-model.ts";
const draft = {
  name: "正文",
  enabled: true,
  keepTags: [{ pre: "<a>", post: "</a>" }],
  excludeTags: [{ pre: "<think>", post: "</think>" }],
};
describe("标签清洗界面", () => {
  it("规则首页保留创建和对话选择入口，移除正则导入", () => {
    const html = renderToString(
      <CleaningRulesManager
        settings={DEFAULT_SETTINGS}
        selectedRuleId={undefined}
        onSelectRule={() => {}}
        onChange={() => {}}
        readRecentMessages={() => []}
      />,
    );
    expect(html).toContain('data-action="create-cleaning-rule"');
    expect(html).toContain("未启用清洗");
    expect(html).not.toContain("正则");
    expect(html).not.toContain("导入");
  });
  it("已有规则点击后直接编辑，首页没有子规则列表或排序入口", () => {
    const html = renderToString(
      <CleaningRulesManager
        settings={{ ...DEFAULT_SETTINGS, cleaningRules: [{ id: "r1", ...draft }] }}
        selectedRuleId="r1"
        onSelectRule={() => {}}
        onChange={() => {}}
        readRecentMessages={() => []}
      />,
    );
    expect(html).toContain('data-action="edit-cleaning-rule"');
    expect(html).toContain("当前对话使用");
    expect(html).not.toContain("列表");
    expect(html).not.toContain("规则顺序");
    expect(html).not.toContain("add-cleaning-rule");
  });
  it("显示两组标签、增删控件和固定语义，移除模式及替换字段", () => {
    const html = renderToString(
      <CleaningRuleEditor
        draft={draft}
        error={undefined}
        onDraftChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("保留标签");
    expect(html).toContain("排除标签");
    expect(html).toContain("先排除后保留");
    expect(html.indexOf("cleaning-excludeTags")).toBeLessThan(html.indexOf("cleaning-keepTags"));
    expect(html).toContain('data-action="add-keepTags"');
    expect(html).toContain('data-action="add-excludeTags"');
    expect(html).toContain("删除保留标签 1");
    expect(html).toContain("未命中时输出空文本");
    expect(html).not.toContain("cleaning-rule-mode");
    expect(html).not.toContain("正则");
    expect(html).not.toContain("替换");
  });
  it("校验错误可见，保存草稿按钮保留", () => {
    const html = renderToString(
      <CleaningRuleEditor
        draft={draft}
        error="请至少添加一个保留或排除标签"
        onDraftChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("请至少添加");
    expect(html).toContain('data-action="save-cleaning-rule"');
  });
  it("测试弹窗显示原文、空结果和未保存提示", () => {
    const result = runCleaningTest({ id: "r1", ...draft }, [{ name: "角色", content: "未命中" }]);
    const html = renderToString(
      <CleaningTestDialog
        form="text"
        text="未命中"
        messages={[]}
        result={result}
        hasDraftOverrides={true}
        loadHint={null}
        onTextChange={() => {}}
        onMessageChange={() => {}}
        onLoadMessages={() => {}}
        onRun={() => {}}
        onCopy={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("原文");
    expect(html).toContain("（空）");
    expect(html).toContain("含未保存修改");
    expect(html).toContain('data-action="run-cleaning-test"');
  });
});
