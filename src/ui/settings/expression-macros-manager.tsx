import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import { effectiveVectorIndexGroups } from "../../features/memory/index.ts";
import { hasSemanticSource, type MemoryMacro } from "../../features/macros/macro-expression.ts";
import type { MemoryMacroService } from "../../features/macros/memory-macro-service.ts";
import { Button, Input, Switch } from "../kit/controls.tsx";
import { copyText, reportError, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import {
  ExpressionMacroEditor,
  MacroExecutionResult,
  newExpressionMacro,
  type MacroSchemaHelp,
} from "./expression-macro-editor.tsx";
import { macroToken } from "./macro-ui-model.ts";

export function ExpressionMacrosManager(props: {
  readonly scope: "chat" | "global";
  readonly prefix: string;
  readonly spaceId?: string;
  readonly chatIdentity?: string;
  readonly macros: readonly MemoryMacro[];
  readonly otherNames: readonly string[];
  readonly service: Pick<
    MemoryMacroService,
    | "skip"
    | "getRecentResults"
    | "subscribe"
    | "testMacro"
    | "getMigrationError"
    | "getMigrationConflicts"
    | "resolveMigrationConflict"
  >;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  readonly onChange: (macros: readonly MemoryMacro[]) => void | Promise<void>;
  readonly onCreateActionChange?: (
    action: { label: string; dataAction: string; disabled: boolean; onClick: () => void } | null,
  ) => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly onMigrationResolved?: () => void;
  readonly onCopyToChat?: (macro: MemoryMacro) => Promise<void>;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const results = useSyncExternalStore(
    props.service.subscribe,
    props.service.getRecentResults,
    props.service.getRecentResults,
  );
  const [tables, setTables] = useState<readonly MacroSchemaHelp[]>([]);
  const [editing, setEditing] = useState<MemoryMacro | null>(null);
  const [error, setError] = useState("");
  const [rename, setRename] = useState<Record<string, string>>({});
  const label = props.scope === "chat" ? "对话宏" : "全局宏";
  function create() {
    setEditing(newExpressionMacro(tables[0]?.key ?? ""));
  }
  useEffect(() => {
    props.onCreateActionChange?.(
      editing
        ? null
        : {
            label: `新建${label}`,
            dataAction: "add-expression-macro",
            disabled: !props.spaceId,
            onClick: create,
          },
    );
    props.onEditingChange?.(editing !== null);
    return () => {
      props.onCreateActionChange?.(null);
      props.onEditingChange?.(false);
    };
  }, [editing, props.spaceId, tables, props.scope]);
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => editing === null || window.confirm("宏有未保存的草稿，放弃并离开吗？"),
    );
    return () => props.registerLeaveGuard?.(null);
  }, [editing, props.registerLeaveGuard]);
  useEffect(() => {
    setEditing(null);
  }, [props.spaceId, props.chatIdentity]);
  useEffect(() => {
    if (!props.spaceId) {
      setTables([]);
      return;
    }
    let cancelled = false;
    const spaceId = props.spaceId;
    void props
      .readTables(spaceId)
      .then(async (rows) =>
        Promise.all(
          rows.map(async (table) => {
            const fields = await props.readFields(spaceId, table.id);
            return {
              key: table.key,
              name: table.name,
              fields,
              groups: effectiveVectorIndexGroups(table.vectorIndex, fields),
            };
          }),
        ),
      )
      .then((rows) => {
        if (!cancelled) {
          setTables(rows);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.spaceId]);
  async function update(macros: readonly MemoryMacro[]) {
    try {
      await props.onChange(macros);
      setError("");
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }
  async function resolve(name: string, kind: "keep" | "overwrite" | "rename") {
    try {
      await props.service.resolveMigrationConflict(name, {
        kind,
        ...(kind === "rename" ? { name: rename[name] ?? "" } : {}),
      });
      props.onMigrationResolved?.();
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }
  if (editing)
    return (
      <div className="stm-settings-detail-page">
        <PageChrome
          header={
            <PanelBar
              title={`${label}：${editing.name || "新建宏"}`}
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label={`返回${label}`}
                  onClick={() => setEditing(null)}
                />
              }
            />
          }
        />
        <ExpressionMacroEditor
          key={editing.id}
          initial={editing}
          names={props.macros.map((macro) => macro.name)}
          tables={tables}
          scope={props.scope}
          onCancel={() => setEditing(null)}
          onSave={async (macro) => {
            await update([...props.macros.filter((item) => item.id !== macro.id), macro]);
            setEditing(null);
          }}
          recent={results.find(
            (result) => result.id === editing.id && result.scope === props.scope,
          )}
          onTest={(macro, lastUserMessage) =>
            props.service.testMacro({ macro, scope: props.scope, lastUserMessage })
          }
        />
      </div>
    );
  return (
    <div data-expression-macros={props.scope}>
      <p className="stm-setting-hint">
        {props.scope === "chat"
          ? "对话宏随当前记忆空间保存；共享空间的对话共用定义。"
          : "全局宏在当前对话的空间执行；语义宏启用后适用于所有对话。"}
        每次实际生成统一计算。停用高优先级同名宏后仍占位。
      </p>
      {results.some((result) => result.status === "running") && (
        <Button onClick={props.service.skip}>跳过本次计算</Button>
      )}
      {props.scope === "chat" && props.service.getMigrationError() && (
        <p role="alert">
          {props.service.getMigrationError()}
          。原始数据保持原值，此对话的命名宏暂停展开；请先修复迁移数据。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {props.scope === "chat" &&
        props.service.getMigrationConflicts().map((conflict) => (
          <section key={conflict.name} data-macro-conflict>
            <h4>迁移冲突：{conflict.name}</h4>
            <p>
              来源：{conflict.source}
              。此对话的该名称在处理前展开为空。覆盖会修改共享空间；改名后需更新提示词引用。
            </p>
            <details>
              <summary>查看冲突定义</summary>
              <pre>
                {JSON.stringify({ existing: conflict.existing, legacy: conflict.legacy }, null, 2)}
              </pre>
            </details>
            <Button onClick={() => void resolve(conflict.name, "keep")}>保留空间定义</Button>
            <Button onClick={() => void resolve(conflict.name, "overwrite")}>覆盖为旧定义</Button>
            <Input
              aria-label={`迁移 ${conflict.name} 的新名称`}
              value={rename[conflict.name] ?? ""}
              onChange={(event) => setRename({ ...rename, [conflict.name]: event.target.value })}
            />
            <Button onClick={() => void resolve(conflict.name, "rename")}>改名导入</Button>
          </section>
        ))}
      {props.macros.map((macro) => (
        <section className="stm-setting-subgroup" key={macro.id} data-macro-id={macro.id}>
          <div className="stm-setting-row">
            <strong>{macro.name}</strong>
            <Switch
              label={`启用 ${macro.name}`}
              checked={macro.enabled}
              onChange={(event) =>
                void update(
                  props.macros.map((item) =>
                    item.id === macro.id ? { ...item, enabled: event.target.checked } : item,
                  ),
                ).catch(reportError)
              }
            />
            <span>{macro.expression.language.toUpperCase()}</span>
          </div>
          <span className="stm-mono">{macroToken(props.prefix, macro.name)}</span>
          {hasSemanticSource(macro) && (
            <p className="stm-setting-hint">
              启用后每次实际生成可能请求 embedding，即使提示词未引用该宏。
              {props.scope === "global" ? "此全局宏适用于所有活动对话。" : ""}
            </p>
          )}
          {props.otherNames.includes(macro.name) && (
            <p>{props.scope === "chat" ? "覆盖同名全局宏" : "被同名对话宏覆盖"}</p>
          )}
          <div className="stm-setting-actions">
            <Button onClick={() => setEditing(macro)}>编辑 / 改名</Button>
            <Button
              onClick={() =>
                void copyText(macroToken(props.prefix, macro.name))
                  .then((copied) =>
                    copied ? reportSuccess("已复制宏调用") : reportWarning("无法写入剪贴板"),
                  )
                  .catch(reportError)
              }
            >
              复制调用
            </Button>
            {props.scope === "global" && props.onCopyToChat && (
              <Button
                disabled={!props.spaceId}
                onClick={() => void props.onCopyToChat!(macro).catch(reportError)}
              >
                复制到对话宏
              </Button>
            )}
            <Button
              variant="danger"
              onClick={() =>
                void update(props.macros.filter((item) => item.id !== macro.id)).catch(reportError)
              }
            >
              删除
            </Button>
          </div>
          <MacroExecutionResult
            title="最近真实执行"
            result={results.find(
              (result) => result.id === macro.id && result.scope === props.scope,
            )}
          />
        </section>
      ))}
      {!props.macros.length && <p>还没有{label}，新建后编辑完整 Query 或 SQL 表达式。</p>}
      {!props.onCreateActionChange && (
        <Button disabled={!props.spaceId} onClick={create}>
          新建{label}
        </Button>
      )}
    </div>
  );
}
