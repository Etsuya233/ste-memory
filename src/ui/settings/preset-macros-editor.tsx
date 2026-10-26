import { useState } from "react";
import type { MemoryMacro } from "../../features/macros/macro-expression.ts";
import type { TablePresetTable } from "../../features/table-presets/preset-model.ts";
import { Button } from "../kit/controls.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { ExpressionMacroEditor, newExpressionMacro } from "./expression-macro-editor.tsx";
export function PresetMacrosEditor(props: {
  readonly macros: readonly MemoryMacro[];
  readonly tables: readonly TablePresetTable[];
  readonly readonly: boolean;
  readonly onChange: (macros: readonly MemoryMacro[]) => void;
  readonly validate: (macros: readonly MemoryMacro[]) => Promise<void>;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState<MemoryMacro | null>(null);
  function close() {
    setEditing(null);
    props.onDirtyChange(false);
  }
  return (
    <Disclosure title="预设对话宏" icon="fa-code" meta={`${props.macros.length} 个`}>
      <p className="stm-setting-hint">
        应用预设时宏随表结构复制到空间，之后各自独立。语义宏在新副本中默认停用，启用后可能请求
        embedding。
      </p>
      {editing ? (
        <div onChangeCapture={() => props.onDirtyChange(true)}>
          <ExpressionMacroEditor
            key={editing.id}
            initial={editing}
            names={props.macros.map((macro) => macro.name)}
            tables={props.tables.map((table) => ({
              ...table,
              groups: table.vectorIndex?.groups ?? [],
            }))}
            scope="preset"
            onCancel={close}
            onSave={async (macro) => {
              const macros = [...props.macros.filter((item) => item.id !== macro.id), macro];
              await props.validate(macros);
              props.onChange(macros);
              close();
            }}
          />
        </div>
      ) : (
        <>
          {props.macros.map((macro) => (
            <div key={macro.id} className="stm-setting-row">
              <span>
                {macro.name} · {macro.expression.language.toUpperCase()} ·{" "}
                {macro.enabled ? "启用" : "停用"}
              </span>
              <Button disabled={props.readonly} onClick={() => setEditing(macro)}>
                编辑宏
              </Button>
              <Button
                disabled={props.readonly}
                variant="danger"
                onClick={() => props.onChange(props.macros.filter((item) => item.id !== macro.id))}
              >
                删除宏
              </Button>
              <details>
                <summary>表达式</summary>
                <pre>{JSON.stringify(macro.expression, null, 2)}</pre>
              </details>
            </div>
          ))}
          <Button
            disabled={props.readonly}
            onClick={() => setEditing(newExpressionMacro(props.tables[0]?.key ?? ""))}
          >
            新增预设宏
          </Button>
        </>
      )}
    </Disclosure>
  );
}
