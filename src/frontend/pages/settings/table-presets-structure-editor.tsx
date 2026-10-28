import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { MemoryField, MemoryFieldId } from "../../../features/memory/index.ts";
import type { ResolvedTablePreset } from "../../../features/table-presets/preset-model.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "../../../ui/primitives/item.tsx";
import { PageHeader, PageContent, PageFooter } from "../../components/page-layout.tsx";
import {
  SchemaEditorFields,
  type SchemaEditor,
  type SchemaFieldsState,
} from "../../components/schema-editor-fields.tsx";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { emptyFieldDraft } from "../../../ui/memory/field-editor-model.ts";
import { presetDisplayStrategySummary } from "../../../ui/settings/table-preset-editor-model.ts";
import type { SettingsSubpageProps } from "./connection-settings-editor.tsx";
import {
  checkedPresetDraft,
  fieldFromDraft,
  removeDraftField,
  removeDraftTable,
  replaceDraftField,
  replaceDraftTable,
} from "./table-presets-structure-model.ts";

interface Editing {
  draft: SchemaEditor;
  initial: SchemaEditor;
  index: number | null;
}

/** Edits stay in the parent preset draft. Only its final Save writes global settings. */
export function TablePresetStructureEditor({
  services,
  controls,
  onBack,
  registerLeaveGuard,
  value,
  dirty,
  onChange,
  onDiscard,
}: SettingsSubpageProps & {
  value: ResolvedTablePreset;
  dirty: boolean;
  onChange: (value: ResolvedTablePreset) => void;
  onDiscard: () => void;
}) {
  const [tableIndex, setTableIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{
    table: number;
    field: number | null;
    name: string;
  } | null>(null);
  const table = tableIndex === null ? null : value.tables[tableIndex]!;
  const localDirty =
    editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(editing.initial);
  const scope = `${value.id}:${tableIndex}:${editing?.draft.kind ?? "detail"}:${editing?.index ?? "new"}`;
  const scroll = usePageScroll(services, `preset-structure:${scope}`, true, !editing);
  const globalLeave = usePageLeave({
    dirty: dirty || localDirty,
    busy: false,
    scope: value.id,
    register: registerLeaveGuard,
    discard: () => {
      setEditing(null);
      onDiscard();
    },
  });
  const localLeave = usePageLeave({
    dirty: localDirty,
    busy: false,
    scope,
    discard: () => setEditing(null),
  });
  useEffect(() => {
    if (!dirty && !localDirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty, localDirty]);
  function back() {
    if (editing)
      localLeave.requestLeave(() => {
        setEditing(null);
        setError(null);
      });
    else if (table) {
      setTableIndex(null);
      setError(null);
    } else onBack();
  }
  function begin(editor: SchemaEditor, index: number | null = null) {
    setError(null);
    setEditing({ draft: editor, initial: editor, index });
  }
  function commit(next: ResolvedTablePreset) {
    onChange(checkedPresetDraft(next));
    setError(null);
  }
  function run(action: () => void) {
    try {
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function complete() {
    if (!editing) return;
    run(() => {
      const editor = editing.draft;
      let next: ResolvedTablePreset;
      if (editor.kind === "table") {
        const metadata = {
          ...editor.draft,
          name: editor.draft.name.trim(),
          key: editor.draft.key.trim(),
        };
        if (editing.index === null)
          next = checkedPresetDraft({
            ...value,
            tables: [...value.tables, { ...metadata, fields: [], displayStrategy: null }],
          });
        else
          next = replaceDraftTable(value, editing.index, {
            ...value.tables[editing.index]!,
            ...metadata,
          });
        onChange(next);
        setTableIndex(editing.index ?? next.tables.length - 1);
      } else {
        const index = tableIndex!;
        if (editor.kind === "field")
          next = replaceDraftField(
            value,
            index,
            editing.index,
            fieldFromDraft(
              editor.draft,
              table!.fields.filter((_, index) => index !== editing.index),
            ),
          );
        else if (editor.kind === "display")
          next = replaceDraftTable(value, index, {
            ...table!,
            displayStrategy:
              editor.draft.type === "field"
                ? { type: "field", fieldKey: editor.draft.fieldId }
                : { type: "template", template: editor.draft.template },
          });
        else
          next = replaceDraftTable(value, index, {
            ...table!,
            vectorIndex: {
              enabled: editor.draft.enabled,
              updateMode: editor.draft.updateMode,
              groups: editor.draft.groups.map((group) => ({
                key: group.key,
                name: group.name,
                fieldKeys: group.fieldIds,
              })),
            },
          });
        onChange(next);
      }
      setEditing(null);
      setError(null);
    });
  }
  function editField(index: number | null) {
    const field = index === null ? null : table!.fields[index]!;
    begin(
      {
        kind: "field",
        original: false,
        dirty: false,
        draft: field
          ? {
              ...field,
              optionsText: field.options.join("\n"),
              referenceTableId: field.referenceTableKey ?? "",
              maxChars: field.maxChars?.toString() ?? "",
              valuePattern: field.valuePattern ?? "",
              valuePatternMessage: field.valuePatternMessage ?? "",
            }
          : {
              ...emptyFieldDraft("short_text"),
              maxChars: "",
              valuePattern: "",
              valuePatternMessage: "",
            },
      },
      index,
    );
  }
  function editTable(index: number | null) {
    const source = index === null ? null : value.tables[index]!;
    begin(
      {
        kind: "table",
        original: source !== null,
        dirty: false,
        draft: source
          ? {
              key: source.key,
              name: source.name,
              description: source.description,
              prompt: source.prompt,
              enabled: source.enabled,
            }
          : { key: "", name: "", description: "", prompt: "", enabled: true },
      },
      index,
    );
  }
  const schema: SchemaFieldsState = {
    tables: value.tables.map((table) => ({ id: table.key, name: table.name })),
    fields:
      table?.fields.map((field, position) => ({
        id: field.key as MemoryFieldId,
        key: field.key as MemoryField["key"],
        name: field.name,
        type: field.type,
        enabled: field.enabled,
        position,
      })) ?? [],
  };
  function moveTable(index: number, offset: -1 | 1) {
    run(() => {
      const tables = [...value.tables];
      [tables[index], tables[index + offset]] = [tables[index + offset]!, tables[index]!];
      commit({ ...value, tables });
    });
  }
  function moveField(index: number, offset: -1 | 1) {
    run(() => {
      const fields = [...table!.fields];
      [fields[index], fields[index + offset]] = [fields[index + offset]!, fields[index]!];
      commit(replaceDraftTable(value, tableIndex!, { ...table!, fields }));
    });
  }
  const heading = editing
    ? {
        table: editing.index === null ? "新增预设表格" : "编辑预设表格",
        field: editing.index === null ? "新增预设字段" : "编辑预设字段",
        display: "预设显示策略",
        vector: "预设向量分组",
      }[editing.draft.kind]
    : (table?.name ?? "预设表结构");
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={heading}
        subtitle={`${value.name} · 草稿`}
        {...controls}
        onBack={back}
        actions={
          !editing ? (
            <Button onClick={() => (table ? editField(null) : editTable(null))}>
              <Plus />
              {table ? "新增字段" : "新增表格"}
            </Button>
          ) : undefined
        }
      />
      <PageContent
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="ste:flex ste:flex-col ste:gap-4"
      >
        {error ? <StatusNotice variant="destructive">{error}</StatusNotice> : null}
        {editing ? (
          <form
            id="preset-structure-editor"
            className="ste:flex ste:flex-col ste:gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              complete();
            }}
          >
            <SchemaEditorFields
              key={scope}
              state={schema}
              editor={editing.draft}
              allowVectorSources={false}
              templatePreviewHint="预设用字段 Key 引用；应用到空间时转换为字段身份。"
              onChange={(next) => setEditing({ ...editing, draft: next })}
            />
            {editing.draft.kind === "display" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  run(() => {
                    commit(
                      replaceDraftTable(value, tableIndex!, { ...table!, displayStrategy: null }),
                    );
                    setEditing(null);
                  })
                }
              >
                使用默认显示方式
              </Button>
            ) : null}
          </form>
        ) : table ? (
          <>
            <p className="ste:text-sm ste:break-words">
              {table.key} · {table.enabled ? "启用" : "停用"} · {table.description}
            </p>
            <Button variant="outline" onClick={() => editTable(tableIndex)}>
              编辑表格属性
            </Button>
            <h2 className="ste:text-sm ste:font-semibold">字段（{table.fields.length}）</h2>
            {table.fields.map((field, index) => (
              <div
                key={field.key}
                className="ste:flex ste:flex-col ste:gap-2 ste:rounded-2xl ste:border ste:p-3"
              >
                <Button
                  variant="ghost"
                  className="ste:h-auto ste:justify-start ste:text-left ste:whitespace-normal"
                  onClick={() => editField(index)}
                >
                  {field.name} · {field.key} · {field.type}
                </Button>
                <div className="ste:flex ste:gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`上移字段 ${field.name}`}
                    disabled={index === 0}
                    onClick={() => moveField(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`下移字段 ${field.name}`}
                    disabled={index === table.fields.length - 1}
                    onClick={() => moveField(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除预设字段 ${field.name}`}
                    onClick={() =>
                      setDeletion({ table: tableIndex!, field: index, name: field.name })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
            {!table.fields.length ? (
              <PageEmpty title="尚无字段" description="添加字段后配置显示策略和向量分组。" />
            ) : null}
            <Button
              variant="outline"
              className="ste:h-auto ste:justify-between ste:py-4 ste:whitespace-normal ste:text-left"
              onClick={() =>
                begin({
                  kind: "display",
                  dirty: false,
                  draft:
                    table.displayStrategy?.type === "field"
                      ? { type: "field", fieldId: table.displayStrategy.fieldKey, template: "" }
                      : table.displayStrategy?.type === "template"
                        ? {
                            type: "template",
                            fieldId: "",
                            template: table.displayStrategy.template,
                          }
                        : { type: "field", fieldId: "", template: "" },
                })
              }
            >
              {presetDisplayStrategySummary(table)}
              <ChevronRight />
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                begin({
                  kind: "vector",
                  dirty: false,
                  draft: {
                    enabled: table.vectorIndex?.enabled ?? false,
                    source: "custom",
                    updateMode: table.vectorIndex?.updateMode ?? "manual",
                    groups:
                      table.vectorIndex?.groups.map((group, index) => ({
                        id: `preset-group-${index}`,
                        key: group.key,
                        name: group.name,
                        fieldIds: group.fieldKeys.map((key) => key as MemoryFieldId),
                      })) ?? [],
                  },
                })
              }
            >
              编辑向量分组
            </Button>
            <Button
              variant="destructive"
              onClick={() => setDeletion({ table: tableIndex!, field: null, name: table.name })}
            >
              <Trash2 />
              删除预设表格
            </Button>
          </>
        ) : (
          <>
            <p className="ste:text-sm ste:text-muted-foreground">
              这里修改预设草稿，完成后返回预设页统一保存。不会修改任何现有对话。
            </p>
            {value.tables.map((table, index) => (
              <div key={table.key} className="ste:flex ste:flex-col ste:gap-2">
                <Item
                  variant="outline"
                  render={<button type="button" />}
                  className="ste:text-left"
                  onClick={() => {
                    setTableIndex(index);
                    setError(null);
                  }}
                  data-action="open-preset-structure-table"
                >
                  <ItemContent>
                    <ItemTitle>{table.name}</ItemTitle>
                    <ItemDescription>
                      {table.key} · {table.fields.length} 个字段
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight />
                  </ItemActions>
                </Item>
                <div className="ste:flex ste:gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`上移表格 ${table.name}`}
                    disabled={index === 0}
                    onClick={() => moveTable(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`下移表格 ${table.name}`}
                    disabled={index === value.tables.length - 1}
                    onClick={() => moveTable(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </div>
              </div>
            ))}
            {!value.tables.length ? <PageEmpty title="尚无表格" /> : null}
          </>
        )}
      </PageContent>
      <PageFooter>
        <p className="ste:text-xs ste:text-muted-foreground">
          {editing ? "完成后写入预设草稿" : dirty ? "预设草稿有修改" : "尚未修改"}
        </p>
        <div className="ste:flex ste:gap-2">
          {editing ? (
            <>
              <Button variant="outline" onClick={back}>
                取消
              </Button>
              <Button type="submit" form="preset-structure-editor">
                完成编辑
              </Button>
            </>
          ) : (
            <Button onClick={onBack}>返回预设</Button>
          )}
        </div>
      </PageFooter>
      {globalLeave.confirmation}
      {localLeave.confirmation}
      <ConfirmAction
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open) setDeletion(null);
        }}
        title={`从预设草稿删除「${deletion?.name ?? ""}」？`}
        description="只修改预设草稿，完成后需要保存；仍被显示策略、向量分组或宏引用的内容需要先调整依赖。"
        confirmLabel="删除草稿项"
        destructive
        onConfirm={() => {
          if (!deletion) return;
          const next =
            deletion.field === null
              ? removeDraftTable(value, deletion.table)
              : removeDraftField(value, deletion.table, deletion.field);
          onChange(next);
          if (deletion.field === null) setTableIndex(null);
        }}
      />
    </div>
  );
}
