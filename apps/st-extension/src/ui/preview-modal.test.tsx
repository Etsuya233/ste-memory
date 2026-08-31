/**
 * 预览弹窗冒烟测试（react-dom/server renderToString，无 jsdom）：验证统一弹窗的
 * 渲染契约——遮罩/标题/等宽文本（空 → 「（空）」）/ 底部右侧 复制·关闭 / children
 * 优先于 text。点击交互（打开/关闭/复制）由使用方组件接线，此处不测。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewModal } from "./preview-modal.tsx";

describe("PreviewModal（预览弹窗 · issue 01 UI 改版）", () => {
  it("text 模式：遮罩 + 标题 + 等宽文本 + 底部右侧 复制/关闭", () => {
    const html = renderToString(
      <PreviewModal
        title="{{ste}}"
        text={"## 人物\n爱丽丝"}
        onCopy={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-stm-section="preview-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-stm-field="preview-modal-title"');
    expect(html).toContain("{{ste}}");
    // 内容等宽渲染（.stm-mono + .stm-modal-text），原文保留换行
    expect(html).toContain('class="stm-mono stm-modal-text"');
    expect(html).toContain("## 人物\n爱丽丝");
    // 底部栏：复制 + 关闭（DOM 顺序 = 内容 → 复制 → 关闭，样式右侧排列由 CSS 负责）
    expect(html).toContain('data-action="copy-preview"');
    expect(html).toContain('data-action="close-preview-modal"');
    const textIdx = html.indexOf('data-stm-field="preview-modal-text"');
    const copyIdx = html.indexOf('data-action="copy-preview"');
    const closeIdx = html.indexOf('data-action="close-preview-modal"');
    expect(textIdx).toBeGreaterThan(0);
    expect(copyIdx).toBeGreaterThan(textIdx);
    expect(closeIdx).toBeGreaterThan(copyIdx);
  });

  it("text 模式：空文本显示「（空）」", () => {
    const html = renderToString(
      <PreviewModal
        title="{{ste::full}}"
        text=""
        onCopy={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("（空）");
  });

  it("children 模式：自定义内容区优先于 text", () => {
    const html = renderToString(
      <PreviewModal
        title="预览「破限」"
        text="忽略我"
        onCopy={() => undefined}
        onClose={() => undefined}
      >
        <div data-stm-field="custom-content">自定义内容</div>
      </PreviewModal>,
    );
    expect(html).toContain('data-stm-field="custom-content"');
    expect(html).not.toContain('data-stm-field="preview-modal-text"');
  });
});