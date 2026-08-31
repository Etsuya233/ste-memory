/**
 * 内置宏列表（双 Scope 宏系统复审：`前缀::名字` 统一分发）：设置 Tab「记忆宏」
 * 组「内置宏」分区。
 *
 * 只读展示系统宏（不可编辑/不可删除）：
 * - {{前缀}}：默认快照（全部启用表分组摘要）；
 * - {{前缀::full}}：全部启用表完整数据（Markdown 表格，受全局字符上限截断）；
 * - {{前缀::<表Key>}}：单表完整数据，按当前活动空间启用表动态生成。
 *   表 Key 是字符串参数，无需满足 ST 标识符规则（{{ste::角色}} 可直接用）。
 * - {{tablesDigest}} / {{systemDefaultPrompt}}：Agent 预设宏（也是内置宏），
 *   与前缀无关、始终列出。
 *
 * 每行右侧「预览」按钮 → 弹窗展示该宏的实际展开文本（读宏服务预计算快照，
 * 点击时读取一次）。数据源 = 端口异步读取（与视图/聊天宏管理器同模式）；
 * 无活动空间时列表可看提示但不展示具体宏。
 */
import { useEffect, useState } from "react";
import type { MemoryTable } from "@ste-memory/core/memory";
import {
  AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
  AGENT_TABLES_DIGEST_MACRO,
} from "../agent-presets/agent-macro-service.ts";
import { BUILTIN_FULL_ARG } from "../macros/memory-macro-service.ts";
import { copyText, reportError, reportSuccess, reportWarning } from "./ui-helpers.tsx";
import { PreviewModal } from "./preview-modal.tsx";

export function BuiltinMacrosList(props: {
  /** 全局前缀（裸标识符，如 ste；来自设置 macroName 去掉花括号） */
  readonly prefix: string;
  /** 活动空间 id；undefined = 无活动空间 */
  readonly spaceId: string | undefined;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  /** 宏展开文本读取口：完整宏名（{{...}} 形态）→ 预计算快照文本（未知 = 空串） */
  readonly readPreview: (name: string) => string;
}) {
  const [tables, setTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  /** 打开的预览：弹窗持有点击时捕获的展开文本（「展开时读一次」） */
  const [preview, setPreview] = useState<{ readonly name: string; readonly text: string } | null>(
    null,
  );

  // 表列表：活动空间变化后重取（内置宏随空间表结构动态生成）
  useEffect(() => {
    const spaceId = props.spaceId;
    if (!spaceId) {
      setTables(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.readTables(spaceId);
        if (!cancelled) setTables(list);
      } catch (readError) {
        reportError(readError);
        if (!cancelled) setTables([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.spaceId, props.readTables]);

  function openPreview(name: string): void {
    setPreview({ name, text: props.readPreview(name) });
  }

  async function copyPreview(): Promise<void> {
    if (!preview) return;
    const ok = await copyText(preview.text);
    if (ok) reportSuccess(`已复制「${preview.name}」展开文本`);
    else reportWarning("复制失败：浏览器不支持剪贴板写入");
  }

  const enabledTables = tables?.filter((table) => table.enabled) ?? [];

  return (
    <div className="stm-setting-subgroup" data-stm-section="builtin-macros">
      <div className="stm-setting-hint">
        <span className="stm-mono">{"{{前缀}}"}</span> 展开全部启用表分组摘要；
        <span className="stm-mono">{"{{前缀::full}}"}</span> 展开全部启用表完整数据；
        <span className="stm-mono">{"{{前缀::表Key}}"}</span> 展开单表完整数据
        （均受全局字符上限截断）；系统宏跟随当前空间、不可编辑；同名自定义宏优先；
        <span className="stm-mono">{"{{tablesDigest}}"}</span> /
        <span className="stm-mono">{"{{systemDefaultPrompt}}"}</span>{" "}
        为 Agent 预设宏（表格摘要 / 系统默认预设提示词）
      </div>
      {!props.spaceId && (
        <div className="stm-preset-warning" data-stm-field="builtin-macros-no-space">
          当前没有活动记忆空间：打开/切换对话后可查看内置宏
        </div>
      )}
      {tables !== undefined && (
        <>
          <BuiltinMacroRow
            name={`{{${props.prefix}}}`}
            summary="默认快照 · 全部启用表分组摘要"
            onPreview={() => openPreview(`{{${props.prefix}}}`)}
          />
          <BuiltinMacroRow
            name={`{{${props.prefix}::${BUILTIN_FULL_ARG}}}`}
            summary="全部启用表 · 完整数据 · 受全局字符上限截断"
            onPreview={() => openPreview(`{{${props.prefix}::${BUILTIN_FULL_ARG}}}`)}
          />
          {enabledTables.map((table) => (
            <BuiltinMacroRow
              key={table.key}
              name={`{{${props.prefix}::${table.key}}}`}
              summary={`表「${table.name}」全部记录`}
              onPreview={() => openPreview(`{{${props.prefix}::${table.key}}}`)}
            />
          ))}
        </>
      )}
      <BuiltinMacroRow
        name={`{{${AGENT_TABLES_DIGEST_MACRO}}}`}
        summary="Agent 提示词 · 全部启用表分组摘要"
        onPreview={() => openPreview(`{{${AGENT_TABLES_DIGEST_MACRO}}}`)}
      />
      <BuiltinMacroRow
        name={`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`}
        summary="Agent 提示词 · 系统默认预设完整提示词"
        onPreview={() => openPreview(`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`)}
      />
      {preview && (
        <PreviewModal
          title={preview.name}
          text={preview.text}
          onCopy={() => void copyPreview()}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/** 内置宏只读行：宏名（等宽）+ 摘要 + 「内置」徽标 + 右侧预览按钮 */
function BuiltinMacroRow(props: {
  readonly name: string;
  readonly summary: string;
  readonly onPreview: () => void;
}) {
  return (
    <div
      className="stm-preset-fragment stm-preset-fragment--builtin"
      data-stm-field={`builtin-macro-${props.name}`}
    >
      <div className="stm-preset-fragment-head">
        <div className="stm-preset-fragment-title" role="presentation">
          <span className="stm-mono">{props.name}</span>
          <span className="stm-preset-fragment-preview">{props.summary}</span>
        </div>
        <span className="stm-builtin-badge">内置</span>
        <button
          type="button"
          className="stm-button stm-preset-preview-btn"
          data-action="preview-macro"
          onClick={props.onPreview}
          title={`预览 ${props.name} 展开文本`}
        >
          预览
        </button>
      </div>
    </div>
  );
}