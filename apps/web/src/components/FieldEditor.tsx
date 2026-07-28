import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createMemoryField,
  deleteMemoryField,
  listMemoryFields,
  updateMemoryField,
  type MemoryField,
  type MemoryFieldInput,
  type MemoryFieldPatch,
} from "../api/memory-fields.ts";
import type { MemoryTable } from "../api/memory-tables.ts";
import { DisplayStrategyForm } from "./DisplayStrategyForm.tsx";
import { FIELD_TYPE_OPTIONS, FieldDialog } from "./FieldDialog.tsx";

interface FieldEditorProps {
  readonly memorySpaceId: string;
  readonly table: MemoryTable;
  readonly tables: readonly MemoryTable[];
  readonly onTableUpdated: (table: MemoryTable) => void;
}

export function FieldEditor(props: FieldEditorProps) {
  const [fields, setFields] = useState<MemoryField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [editing, setEditing] = useState<MemoryField | "create">();
  const [deleting, setDeleting] = useState<MemoryField>();
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listMemoryFields(props.memorySpaceId, props.table.id)
      .then((loaded) => {
        if (active) setFields(loaded);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取字段");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.memorySpaceId, props.table.id]);

  async function create(input: MemoryFieldInput | MemoryFieldPatch) {
    const created = await createMemoryField(
      props.memorySpaceId,
      props.table.id,
      input as MemoryFieldInput,
    );
    setFields((current) => [...current, created].toSorted((a, b) => a.position - b.position));
    if (input.required && input.enabled === false) {
      setWarning("停用必填字段后，Agent 可能无法创建合法记录");
    }
  }

  async function update(field: MemoryField, patch: MemoryFieldPatch) {
    const result = await updateMemoryField(props.memorySpaceId, props.table.id, field.id, patch);
    setFields((current) =>
      current
        .map((item) => (item.id === result.field.id ? result.field : item))
        .toSorted((a, b) => a.position - b.position),
    );
    setWarning(result.warnings[0]);
  }

  async function toggle(field: MemoryField, enabled: boolean) {
    setBusyId(field.id);
    setError(undefined);
    try {
      await update(field, { enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法修改字段状态");
    } finally {
      setBusyId(undefined);
    }
  }

  async function move(field: MemoryField, offset: -1 | 1) {
    const index = fields.findIndex((item) => item.id === field.id);
    const targetIndex = index + offset;
    if (!fields[targetIndex]) return;
    setBusyId(field.id);
    setError(undefined);
    try {
      const reordered = [...fields];
      reordered.splice(index, 1);
      reordered.splice(targetIndex, 0, field);
      const persisted = await Promise.all(
        reordered.map(async (item, position) => {
          if (item.position === position) return item;
          const result = await updateMemoryField(props.memorySpaceId, props.table.id, item.id, {
            position,
          });
          return result.field;
        }),
      );
      setFields(persisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法调整字段顺序");
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusyId(deleting.id);
    setError(undefined);
    try {
      await deleteMemoryField(props.memorySpaceId, props.table.id, deleting.id);
      setFields((current) => current.filter((field) => field.id !== deleting.id));
      setDeleting(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除字段");
      setDeleting(undefined);
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div className="field-editor">
      <DisplayStrategyForm
        fields={fields}
        memorySpaceId={props.memorySpaceId}
        table={props.table}
        onSaved={props.onTableUpdated}
      />
      <section className="field-definition-list">
        <header className="definition-section-heading">
          <div>
            <h3>字段定义</h3>
            <span>{fields.length} 个字段</span>
          </div>
          <button className="primary-button" type="button" onClick={() => setEditing("create")}>
            <Plus size={15} /> 新增字段
          </button>
        </header>
        {loading ? <div className="field-list-state">正在读取字段...</div> : null}
        {!loading && fields.length === 0 ? (
          <div className="field-list-state">尚未添加字段</div>
        ) : null}
        {fields.map((field, index) => (
          <article className={`field-definition ${field.enabled ? "" : "disabled"}`} key={field.id}>
            <div className="field-order">
              <strong>{index + 1}</strong>
              <div>
                <button
                  type="button"
                  aria-label={`上移 ${field.name}`}
                  disabled={index === 0 || busyId === field.id}
                  onClick={() => void move(field, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`下移 ${field.name}`}
                  disabled={index === fields.length - 1 || busyId === field.id}
                  onClick={() => void move(field, 1)}
                >
                  <ArrowDown size={13} />
                </button>
              </div>
            </div>
            <div className="field-summary">
              <strong>{field.name}</strong>
              <span>
                {FIELD_TYPE_OPTIONS.find((option) => option.value === field.type)?.label}
                {field.required ? " · 必填" : ""}
              </span>
            </div>
            <label className="table-toggle" title={field.enabled ? "停用字段" : "启用字段"}>
              <input
                type="checkbox"
                checked={field.enabled}
                disabled={busyId === field.id}
                aria-label={`${field.enabled ? "停用" : "启用"} ${field.name}`}
                onChange={(event) => void toggle(field, event.target.checked)}
              />
              <span />
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label={`编辑 ${field.name}`}
              onClick={() => setEditing(field)}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-button danger"
              type="button"
              aria-label={`删除 ${field.name}`}
              onClick={() => setDeleting(field)}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
      </section>
      {warning ? (
        <div className="field-warning">
          <button type="button" aria-label="关闭警告" onClick={() => setWarning(undefined)}>
            <X size={13} />
          </button>
          {warning}
        </div>
      ) : null}
      {error ? <p className="form-error field-editor-error">{error}</p> : null}
      {editing ? (
        <FieldDialog
          field={editing === "create" ? undefined : editing}
          nextPosition={fields.length}
          tables={props.tables}
          onClose={() => setEditing(undefined)}
          onSubmit={editing === "create" ? create : (input) => update(editing, input)}
        />
      ) : null}
      {deleting ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog" role="dialog" aria-modal="true">
            <header className="dialog-header">
              <h2>删除字段</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setDeleting(undefined)}
              >
                <X size={18} />
              </button>
            </header>
            <p className="delete-copy">
              将物理删除“{deleting.name}”。删除后无法恢复，请确认现有记录不再需要该字段。
            </p>
            <footer className="dialog-footer">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDeleting(undefined)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={busyId === deleting.id}
                onClick={() => void remove()}
              >
                确认物理删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
