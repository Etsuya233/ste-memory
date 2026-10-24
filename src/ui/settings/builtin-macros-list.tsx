/**
 * 内置宏列表（只读）：设置 Tab「记忆宏」组「内置宏」分区。
 *
 * - 默认快照：{{前缀}}；
 * - 完整数据：{{前缀::full}} + 当前空间每个启用表的 {{前缀::表Key}}；
 * - Agent 预设宏：{{tablesDigest}} / {{systemDefaultPrompt}}（与前缀无关）。
 *
 * 行样式与全局宏/对话宏一致：点击整行预览，右侧独立复制宏名按钮；
 * 行内展示输出体积/空/截断状态。
 */
import { useEffect, useState } from "react";
import type { MemoryTable } from "../../features/memory/index.ts";
import {
  AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
  AGENT_TABLES_DIGEST_MACRO,
} from "../../features/agent-presets/agent-macro-service.ts";
import { BUILTIN_FULL_ARG } from "../../features/macros/memory-macro-service.ts";
import { copyText, reportError, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import { PreviewModal } from "../memory/preview-modal.tsx";
import { macroOutputLabel } from "./macro-ui-model.ts";

export function BuiltinMacrosList(props: {
  /** 合法宏名（裸标识符，如 ste） */
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
    try {
      const ok = await copyText(preview.text);
      if (ok) reportSuccess(`已复制「${preview.name}」展开文本`);
      else reportWarning("复制失败：浏览器不支持剪贴板写入");
    } catch {
      reportWarning("复制失败：无法写入剪贴板");
    }
  }

  function copyToken(name: string): void {
    void copyText(name)
      .then((copied) => {
        if (copied) reportSuccess(`已复制 ${name}`);
        else reportWarning("复制失败：浏览器不支持剪贴板写入");
      })
      .catch(() => reportWarning("复制失败：无法写入剪贴板"));
  }

  const enabledTables = tables?.filter((table) => table.enabled) ?? [];
  const hasActiveSpace = props.spaceId !== undefined;
  const defaultName = props.prefix === "" ? "" : `{{${props.prefix}}}`;
  const fullName = props.prefix === "" ? "" : `{{${props.prefix}::${BUILTIN_FULL_ARG}}}`;

  function statusFor(name: string): string {
    return macroOutputLabel(props.readPreview(name));
  }

  return (
    <div className="stm-setting-subgroup" data-stm-section="builtin-macros">
      {!hasActiveSpace && (
        <div className="stm-macro-notice" data-stm-field="builtin-macros-no-space">
          当前没有活动记忆空间：打开或切换对话后可查看记忆宏；Agent 预设宏仍可预览。
        </div>
      )}
      {hasActiveSpace && props.prefix === "" && (
        <div className="stm-macro-notice" data-stm-field="builtin-macros-no-prefix">
          宏前缀无效：先到宏设置页配置有效宏前缀，才能查看记忆类内置宏。
        </div>
      )}
      {hasActiveSpace && tables !== undefined && defaultName !== "" && (
        <div className="stm-macro-group">
          <div className="stm-section-label">默认快照</div>
          <div className="stm-grouped-list stm-macro-list">
            <BuiltinMacroRow
              name={defaultName}
              summary="全部启用表分组摘要"
              status={statusFor(defaultName)}
              onPreview={() => openPreview(defaultName)}
              onCopy={() => copyToken(defaultName)}
            />
          </div>
        </div>
      )}
      {hasActiveSpace && tables !== undefined && fullName !== "" && (
        <div className="stm-macro-group">
          <div className="stm-section-label">完整数据</div>
          <div className="stm-grouped-list stm-macro-list">
            <BuiltinMacroRow
              name={fullName}
              summary="全部启用表 · Markdown 表格"
              status={statusFor(fullName)}
              onPreview={() => openPreview(fullName)}
              onCopy={() => copyToken(fullName)}
            />
            {enabledTables.map((table) => {
              const name = `{{${props.prefix}::${table.key}}}`;
              return (
                <BuiltinMacroRow
                  key={table.key}
                  name={name}
                  summary={`表「${table.name}」全部记录`}
                  status={statusFor(name)}
                  onPreview={() => openPreview(name)}
                  onCopy={() => copyToken(name)}
                />
              );
            })}
          </div>
        </div>
      )}
      {hasActiveSpace && tables === undefined && (
        <div className="stm-setting-hint" data-stm-field="builtin-macros-loading">
          正在读取当前空间的表格…
        </div>
      )}
      <div className="stm-macro-group">
        <div className="stm-section-label">Agent 预设宏</div>
        <div className="stm-grouped-list stm-macro-list">
          <BuiltinMacroRow
            name={`{{${AGENT_TABLES_DIGEST_MACRO}}}`}
            summary="Agent 提示词 · 全部启用表分组摘要"
            status={statusFor(`{{${AGENT_TABLES_DIGEST_MACRO}}}`)}
            onPreview={() => openPreview(`{{${AGENT_TABLES_DIGEST_MACRO}}}`)}
            onCopy={() => copyToken(`{{${AGENT_TABLES_DIGEST_MACRO}}}`)}
          />
          <BuiltinMacroRow
            name={`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`}
            summary="Agent 提示词 · 系统默认预设完整提示词"
            status={statusFor(`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`)}
            onPreview={() => openPreview(`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`)}
            onCopy={() => copyToken(`{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`)}
          />
        </div>
      </div>
      <div className="stm-setting-hint">
        内置宏跟随当前空间，只读；同名优先级：对话宏 → 全局宏 → 内置宏。
      </div>
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

/** 内置宏只读行：与全局/对话宏共用行结构；主按钮预览，右侧复制宏表达式。 */
function BuiltinMacroRow(props: {
  readonly name: string;
  readonly summary: string;
  readonly status: string;
  readonly onPreview: () => void;
  readonly onCopy: () => void;
}) {
  return (
    <div data-stm-field={`builtin-macro-${props.name}`}>
      <div className="stm-macro-row">
        <div className="stm-macro-row-static">
          <span className="stm-macro-row-content">
            <span className="stm-macro-row-title-line">
              <span className="stm-settings-item-title stm-mono">{props.name}</span>
            </span>
            <span className="stm-macro-row-meta">
              {props.status} · {props.summary}
            </span>
          </span>
        </div>
        <div className="stm-macro-row-actions">
          <button
            type="button"
            className="stm-macro-row-action"
            data-action="preview-macro"
            aria-label={`预览宏 ${props.name}`}
            title="预览展开文本"
            onClick={props.onPreview}
          >
            <i className="fa-regular fa-eye" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="stm-macro-row-action"
            data-action="copy-builtin-macro-token"
            aria-label={`复制宏名 ${props.name}`}
            title="复制宏名"
            onClick={props.onCopy}
          >
            <i className="fa-regular fa-copy" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
