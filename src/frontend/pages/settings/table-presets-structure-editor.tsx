import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { MemoryField, MemoryFieldId } from "../../../features/memory/index.ts";
import type { ResolvedTablePreset } from "../../../features/table-presets/preset-model.ts";
import { Button } from "../../primitives/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../primitives/item.tsx";
import { PageHeader, PageContent, PageFooter } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import {
  SchemaEditorFields,
  type SchemaEditor,
  type SchemaFieldsState,
} from "../../components/schema-editor-fields.tsx";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { emptyFieldDraft } from "../../models/memory/field-editor-model.ts";
import { presetDisplayStrategySummary } from "../../models/settings/table-preset-editor-model.ts";
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
      <PageHeader title={heading} subtitle={`${value.name} · 草稿`} {...controls} onBack={back} />
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
            <PageSection
              title="表格属性"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => editTable(tableIndex)}
                >
                  编辑表格属性
                </Button>
              }
            >
              <p className="ste:text-sm ste:break-words">
                {table.key} · {table.enabled ? "启用" : "停用"}
                {table.description ? ` · ${table.description}` : null}
              </p>
            </PageSection>
            <PageSection
              title="字段"
              action={
                <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
                  <span className="ste:text-xs ste:text-muted-foreground">
                    {table.fields.length} 项
                  </span>
                  <Button type="button" size="sm" onClick={() => editField(null)}>
                    <Plus />
                    新增字段
                  </Button>
                </div>
              }
              bodyClassName="ste:p-0"
            >
              {table.fields.length ? (
                <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
                  {table.fields.map((field, index) => (
                    <div role="listitem" key={field.key}>
                      <Item className="ste:gap-0 ste:rounded-none ste:border-0 ste:p-0 ste:hover:bg-muted/50">
                        <div
                          role="button"
                          tabIndex={0}
                          className="ste:flex ste:min-w-0 ste:flex-1 ste:cursor-pointer ste:items-center ste:px-4 ste:py-3 ste:text-left ste:outline-none ste:focus-visible:bg-muted/50 ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:focus-visible:ring-inset"
                          title={`编辑字段 ${field.name}`}
                          onClick={() => editField(index)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            editField(index);
                          }}
                        >
                          <span className="ste:min-w-0 ste:break-words ste:text-sm">
                            {field.name} · {field.key} · {field.type}
                          </span>
                        </div>
                        <ItemActions className="ste:gap-1 ste:px-2 ste:py-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`上移字段 ${field.name}`}
                            disabled={index === 0}
                            onClick={() => moveField(index, -1)}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`下移字段 ${field.name}`}
                            disabled={index === table.fields.length - 1}
                            onClick={() => moveField(index, 1)}
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除预设字段 ${field.name}`}
                            onClick={() =>
                              setDeletion({ table: tableIndex!, field: index, name: field.name })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </ItemActions>
                      </Item>
                    </div>
                  ))}
                </ItemGroup>
              ) : (
                <PageEmpty title="尚无字段" description="添加字段后配置显示策略和向量分组。" />
              )}
            </PageSection>
            <PageSection title="显示与索引" bodyClassName="ste:p-0">
              <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
                <div role="listitem">
                  <Item
                    render={<button type="button" />}
                    className="ste:rounded-none ste:border-0 ste:px-4 ste:py-3 ste:text-left ste:hover:bg-muted/50 ste:focus-visible:ring-inset"
                    onClick={() =>
                      begin({
                        kind: "display",
                        dirty: false,
                        draft:
                          table.displayStrategy?.type === "field"
                            ? {
                                type: "field",
                                fieldId: table.displayStrategy.fieldKey,
                                template: "",
                              }
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
                    <ItemContent>
                      <span className="ste:min-w-0 ste:break-words ste:text-sm">
                        {presetDisplayStrategySummary(table)}
                      </span>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </div>
                <div role="listitem">
                  <Item
                    render={<button type="button" />}
                    className="ste:rounded-none ste:border-0 ste:px-4 ste:py-3 ste:text-left ste:hover:bg-muted/50 ste:focus-visible:ring-inset"
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
                    <ItemContent>
                      <span className="ste:text-sm">编辑向量分组</span>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </div>
              </ItemGroup>
            </PageSection>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setDeletion({ table: tableIndex!, field: null, name: table.name })}
            >
              <Trash2 />
              删除预设表格
            </Button>
          </>
        ) : (
          <PageSection
            title="表格"
            action={
              <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
                <span className="ste:text-xs ste:text-muted-foreground">
                  {value.tables.length} 项
                </span>
                <Button type="button" size="sm" onClick={() => editTable(null)}>
                  <Plus />
                  新增表格
                </Button>
              </div>
            }
            bodyClassName="ste:p-0"
          >
            <p className="ste:border-b ste:border-border ste:px-4 ste:py-2.5 ste:text-xs ste:break-words ste:text-muted-foreground">
              这里修改预设草稿，完成后返回预设页统一保存。不会修改任何现有对话。
            </p>
            {value.tables.length ? (
              <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
                {value.tables.map((table, index) => (
                  <div role="listitem" key={table.key}>
                    <Item className="ste:gap-0 ste:rounded-none ste:border-0 ste:p-0 ste:hover:bg-muted/50">
                      <div
                        role="button"
                        tabIndex={0}
                        className="ste:flex ste:min-w-0 ste:flex-1 ste:cursor-pointer ste:flex-col ste:gap-1 ste:px-4 ste:py-3 ste:text-left ste:outline-none ste:focus-visible:bg-muted/50 ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:focus-visible:ring-inset"
                        data-action="open-preset-structure-table"
                        onClick={() => {
                          setTableIndex(index);
                          setError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setTableIndex(index);
                          setError(null);
                        }}
                      >
                        <ItemContent>
                          <ItemTitle>{table.name}</ItemTitle>
                          <ItemDescription>
                            {table.key} · {table.fields.length} 个字段
                          </ItemDescription>
                        </ItemContent>
                      </div>
                      <ItemActions className="ste:gap-1 ste:px-2 ste:py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`上移表格 ${table.name}`}
                          disabled={index === 0}
                          onClick={() => moveTable(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`下移表格 ${table.name}`}
                          disabled={index === value.tables.length - 1}
                          onClick={() => moveTable(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  </div>
                ))}
              </ItemGroup>
            ) : (
              <PageEmpty title="尚无表格" />
            )}
          </PageSection>
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
