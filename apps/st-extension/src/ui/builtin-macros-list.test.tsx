/**
 * 内置宏列表冒烟测试（react-dom/server renderToString，无 jsdom）：表列表经
 * useEffect 异步读取，SSR 不执行——空间相关行不渲染，只验证随组件稳定的契约：
 * Agent 预设宏两行始终列出（含预览按钮）、无空间空态提示。空间行（{{前缀}} 等）
 * 的渲染由真机验收脚本覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuiltinMacrosList } from "./builtin-macros-list.tsx";

describe("BuiltinMacrosList（内置宏 · issue 01 UI 改版）", () => {
  it("Agent 预设宏行始终列出（{{tablesDigest}}/{{systemDefaultPrompt}}），每行预览按钮", () => {
    const html = renderToString(
      <BuiltinMacrosList
        prefix="ste"
        spaceId="space-1"
        readTables={async () => []}
        readPreview={() => ""}
      />,
    );
    expect(html).toContain('data-stm-field="builtin-macro-{{tablesDigest}}"');
    expect(html).toContain('data-stm-field="builtin-macro-{{systemDefaultPrompt}}"');
    expect(html).toContain('data-action="preview-macro"');
    expect(html.match(/data-action="preview-macro"/g)).toHaveLength(2);
    expect(html).toContain("Agent 提示词 · 全部启用表分组摘要");
  });

  it("无活动空间：空态提示就位，Agent 预设宏行仍可预览（内容为空由弹窗展示「（空）」）", () => {
    const html = renderToString(
      <BuiltinMacrosList
        prefix="ste"
        spaceId={undefined}
        readTables={async () => []}
        readPreview={() => ""}
      />,
    );
    expect(html).toContain('data-stm-field="builtin-macros-no-space"');
    expect(html).not.toContain('data-stm-field="builtin-macro-{{ste}}"');
    expect(html).toContain('data-stm-field="builtin-macro-{{tablesDigest}}"');
    expect(html).toContain('data-action="preview-macro"');
  });
});