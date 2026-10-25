import { Dialog } from "../kit/dialog.tsx";
import { Button } from "../kit/controls.tsx";
/**
 * 预览弹窗（issue 01 UI 改版）：宏预览与 Agent 预设预览统一使用的模态框。
 *
 * 结构：遮罩（点击关闭） + 对话框（标题 + 内容区 + 底部栏）。底部栏右侧固定
 * 「复制 / 关闭」两个按钮，复制行为由调用方注入（宏 = 该行展开文本；预设 =
 * 全部展开消息序列）。内容形态两种：
 * - text 模式：单段等宽文本（宏预览），空串显示「（空）」；
 * - children 模式：调用方自定义内容区（预设预览的输入框 + 分组卡片）。
 * 预览数据在点击入口时读取一次，弹窗持有捕获到的内容（沿用「展开时读一次」语义）。
 */
import type { ReactNode } from "react";

export function PreviewModal(props: {
  readonly title: string;
  /** 单段等宽文本（宏预览）；空串显示「（空）」；与 children 互斥，children 优先 */
  readonly text?: string;
  /** 自定义内容区（Agent 预设预览等）；提供时优先于 text */
  readonly children?: ReactNode;
  /** 底部「复制」行为（调用方负责复制 + 结果提示） */
  readonly onCopy: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      label={props.title}
      onClose={props.onClose}
      data-stm-section="preview-modal"
      contentClassName="stm-modal"
    >
      <div className="stm-modal-title" data-stm-field="preview-modal-title">
        {props.title}
      </div>
      <div className="stm-modal-body">
        {props.children !== undefined ? (
          props.children
        ) : (
          <pre className="stm-mono stm-modal-text" data-stm-field="preview-modal-text">
            {props.text === "" ? "（空）" : props.text}
          </pre>
        )}
      </div>
      <div className="stm-modal-footer">
        <Button
          type="button"

          data-action="copy-preview"
          onClick={props.onCopy}
        >
          复制
        </Button>
        <Button
          type="button"

          data-action="close-preview-modal"
          onClick={props.onClose}
        >
          关闭
        </Button>
      </div>
    </Dialog>
  );
}
