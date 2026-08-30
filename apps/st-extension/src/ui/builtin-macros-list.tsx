/**
 * 内置宏列表（双 Scope 宏系统复审：`前缀::名字` 统一分发）：设置 Tab「记忆宏」
 * 组「内置宏」分区。
 *
 * 只读展示系统宏（不可编辑/不可删除）：
 * - {{前缀}}：默认快照（全部启用表分组摘要）；
 * - {{前缀::full}}：全部启用表完整数据（Markdown 表格，受全局字符上限截断）；
 * - {{前缀::<表Key>}}：单表完整数据，按当前活动空间启用表动态生成。
 *   表 Key 是字符串参数，无需满足 ST 标识符规则（{{ste::角色}} 可直接用）。
 *
 * 数据源 = 端口异步读取（与视图/聊天宏管理器同模式）；无活动空间时列表可看
 * 提示但不展示具体宏。
 */
import { useEffect, useState } from "react";
import type { MemoryTable } from "@ste-memory/core/memory";
import { BUILTIN_FULL_ARG } from "../macros/memory-macro-service.ts";
import { reportError } from "./ui-helpers.tsx";

export function BuiltinMacrosList(props: {
  /** 全局前缀（裸标识符，如 ste；来自设置 macroName 去掉花括号） */
  readonly prefix: string;
  /** 活动空间 id；undefined = 无活动空间 */
  readonly spaceId: string | undefined;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
}) {
  const [tables, setTables] = useState<readonly MemoryTable[] | undefined>(undefined);

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

  const enabledTables = tables?.filter((table) => table.enabled) ?? [];

  return (
    <div className="stm-setting-subgroup" data-stm-section="builtin-macros">
      <div className="stm-setting-hint">
        <span className="stm-mono">{"{{前缀}}"}</span> 展开全部启用表分组摘要；
        <span className="stm-mono">{"{{前缀::full}}"}</span> 展开全部启用表完整数据；
        <span className="stm-mono">{"{{前缀::表Key}}"}</span> 展开单表完整数据
        （均受全局字符上限截断）；系统宏跟随当前空间、不可编辑；同名自定义宏优先
      </div>
      {!props.spaceId && (
        <div className="stm-preset-warning" data-stm-field="builtin-macros-no-space">
          当前没有活动记忆空间：打开/切换对话后可查看内置宏
        </div>
      )}
      {tables !== undefined && (
        <>
          <BuiltinMacroRow name={props.prefix} summary="默认快照 · 全部启用表分组摘要" />
          <BuiltinMacroRow
            name={`${props.prefix}::${BUILTIN_FULL_ARG}`}
            summary="全部启用表 · 完整数据 · 受全局字符上限截断"
          />
          {enabledTables.map((table) => (
            <BuiltinMacroRow
              key={table.key}
              name={`${props.prefix}::${table.key}`}
              summary={`表「${table.name}」全部记录`}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** 内置宏只读行：宏名（等宽）+ 摘要 + 「内置」徽标；无操作按钮 */
function BuiltinMacroRow(props: { readonly name: string; readonly summary: string }) {
  return (
    <div
      className="stm-preset-fragment stm-preset-fragment--builtin"
      data-stm-field={`builtin-macro-${props.name}`}
    >
      <div className="stm-preset-fragment-head">
        <div className="stm-preset-fragment-title" role="presentation">
          <span className="stm-mono">{`{{${props.name}}}`}</span>
          <span className="stm-preset-fragment-preview">{props.summary}</span>
        </div>
        <span className="stm-builtin-badge">内置</span>
      </div>
    </div>
  );
}
