import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus, Table2, Trash2 } from "lucide-react";
import type { MemoryFieldId } from "../../../features/memory/index.ts";
import { effectiveVectorIndexGroups } from "../../../features/memory/index.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../../ui/primitives/item.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Switch } from "../../../ui/primitives/switch.tsx";
import { Checkbox } from "../../../ui/primitives/checkbox.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import {
  PageHeader,
  PageContent,
  SaveActions,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";
import {
  displayStrategySummary,
  templateFieldRef,
} from "../../../ui/memory/display-strategy-model.ts";
import {
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
} from "../../../ui/memory/field-editor-model.ts";
import type { TablesWorkspace, TableEditor, TablesSnapshot } from "./tables-workspace.ts";

export function TablesPage({
  workspace,
  controls,
  registerLeaveGuard,
}: {
  workspace: TablesWorkspace;
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [deletion, setDeletion] = useState<{
    kind: "table" | "field" | "vectors";
    fieldId?: MemoryFieldId;
    name: string;
  } | null>(null);
  useEffect(() => setDeletion(null), [state.context?.chatKey, state.context?.spaceId]);
  const { requestLeave, confirmation } = usePageLeave({
    dirty: !!state.editor?.dirty,
    busy: state.saving,
    scope: JSON.stringify([state.context?.chatKey, state.context?.spaceId]),
    discard: workspace.discard,
    register: registerLeaveGuard,
  });
  const table = state.tables.find((item) => item.id === state.tableId);
  const back = () =>
    requestLeave(() => {
      if (state.editor) workspace.discard();
      else void workspace.selectTable(null);
    });
  const title = state.editor
    ? {
        table: state.editor.kind === "table" && !state.editor.original ? "创建表格" : "编辑表格",
        field: "编辑字段",
        display: "显示策略",
        vector: "向量索引",
      }[state.editor.kind]
    : (table?.name ?? "表格");
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={title}
        subtitle={state.editor ? "修改后保存到当前对话" : state.context?.title}
        icon={Table2}
        onBack={state.tableId || state.editor ? back : undefined}
        {...controls}
        busy={state.saving}
        actions={
          !state.editor && !state.tableId ? (
            <Button
              data-action="create-table"
              disabled={state.saving || !state.context}
              onClick={() => workspace.begin("table")}
            >
              <Plus />
              创建表格
            </Button>
          ) : undefined
        }
      />
      <PageContent>
        <fieldset
          disabled={state.saving}
          className="ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-5 ste:border-0 ste:p-0"
        >
          {state.error ? (
            <PageError
              title="操作失败"
              error={state.error}
              onRetry={!state.editor ? () => void workspace.refresh() : undefined}
            />
          ) : null}
          {state.notice ? <StatusNotice>{state.notice}</StatusNotice> : null}
          {state.persistenceError ? (
            <StatusNotice variant="destructive">
              修改已提交，但对话文件保存失败：{state.persistenceError}
              <Button disabled={state.saving} onClick={() => void workspace.retryPersistence()}>
                重试文件保存
              </Button>
            </StatusNotice>
          ) : null}
          {!state.context ? (
            <PageEmpty title="请选择对话" />
          ) : state.loading ? (
            <p role="status">正在加载表结构…</p>
          ) : null}
          {state.editor ? (
            <form
              id="ste-table-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void workspace.save();
              }}
            >
              <fieldset
                disabled={state.saving}
                className="ste:flex ste:min-w-0 ste:flex-col ste:gap-5 ste:border-0 ste:p-0"
              >
                <EditorFields
                  state={state}
                  editor={state.editor}
                  onChange={(editor) => workspace.change(editor)}
                />
                {state.editor.kind === "display" || state.editor.kind === "vector" ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void workspace.preview()}
                    >
                      预览当前草稿
                    </Button>
                    {state.previews.map((preview, index) => (
                      <div
                        key={index}
                        className="ste:rounded-xl ste:bg-muted ste:p-3 ste:break-words"
                      >
                        {preview}
                      </div>
                    ))}
                  </>
                ) : null}
              </fieldset>
            </form>
          ) : table ? (
            <>
              <section className="ste:space-y-3">
                <div className="ste:flex ste:items-start ste:justify-between ste:gap-3">
                  <div>
                    <p className="ste:font-mono ste:text-sm ste:text-muted-foreground">
                      {table.key} · {table.enabled ? "已启用" : "已停用"}
                    </p>
                    <p className="ste:mt-2 ste:whitespace-pre-wrap ste:break-words">
                      {table.description || "暂无描述"}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => workspace.begin("table")}>
                    编辑表格
                  </Button>
                </div>
                {table.prompt ? (
                  <p className="ste:whitespace-pre-wrap ste:rounded-xl ste:bg-muted ste:p-3 ste:text-sm">
                    {table.prompt}
                  </p>
                ) : null}
              </section>
              <section className="ste:space-y-3">
                <div className="ste:flex ste:items-center ste:justify-between">
                  <h2 className="ste:text-lg ste:font-semibold">
                    字段 <span className="ste:text-muted-foreground">{state.fields.length}</span>
                  </h2>
                  <Button variant="outline" onClick={() => workspace.begin("field")}>
                    <Plus />
                    新增字段
                  </Button>
                </div>
                {state.fields.length ? (
                  state.fields.map((field) => (
                    <div
                      key={field.id}
                      className="ste:flex ste:items-center ste:gap-2 ste:rounded-2xl ste:border ste:p-3"
                    >
                      <Button
                        variant="ghost"
                        className="ste:h-auto ste:min-w-0 ste:flex-1 ste:flex-col ste:items-start ste:gap-1 ste:p-0 ste:text-left ste:whitespace-normal"
                        onClick={() => workspace.begin("field", field)}
                      >
                        <span className="ste:font-medium">
                          {field.name}
                          {field.required ? " *" : ""}
                        </span>
                        <span className="ste:text-xs ste:text-muted-foreground ste:break-all">
                          {field.key} · {field.type} · {field.enabled ? "启用" : "停用"}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除字段 ${field.name}`}
                        disabled={state.saving}
                        onClick={() =>
                          setDeletion({ kind: "field", fieldId: field.id, name: field.name })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))
                ) : (
                  <PageEmpty
                    title="尚未添加字段"
                    description="先创建字段，再配置记录的显示方式。"
                  />
                )}
              </section>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4 ste:whitespace-normal ste:text-left"
                onClick={() => workspace.begin("display")}
              >
                <span>
                  显示策略
                  <br />
                  <span className="ste:text-xs ste:text-muted-foreground">
                    {displayStrategySummary(table.displayStrategy, state.fields)}
                  </span>
                </span>
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => workspace.begin("vector")}
              >
                <span>向量索引 · {table.vectorIndex?.enabled ? "已启用" : "未启用"}</span>
                <ChevronRight />
              </Button>
              <div className="ste:flex ste:flex-wrap ste:gap-2">
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => void workspace.index("build").catch(() => {})}
                >
                  补建索引
                </Button>
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => void workspace.index("rebuild").catch(() => {})}
                >
                  强制重算
                </Button>
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => setDeletion({ kind: "vectors", name: table.name })}
                >
                  清除向量
                </Button>
              </div>
              <Button
                variant="destructive"
                disabled={state.saving}
                onClick={() => setDeletion({ kind: "table", name: table.name })}
              >
                <Trash2 />
                删除表格
              </Button>
            </>
          ) : !state.loading && state.context ? (
            <>
              {state.tables.length ? (
                state.tables.map((item) => (
                  <Item
                    key={item.id}
                    render={<button type="button" />}
                    variant="outline"
                    data-action="open-table"
                    onClick={() => void workspace.selectTable(item.id)}
                    className="ste:cursor-pointer ste:text-left ste:hover:bg-muted"
                  >
                    <Table2 className="ste:size-5 ste:shrink-0 ste:text-muted-foreground" />
                    <ItemContent>
                      <ItemTitle>{item.name}</ItemTitle>
                      <ItemDescription>
                        {item.key} · {item.enabled ? "启用" : "停用"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:shrink-0" />
                    </ItemActions>
                  </Item>
                ))
              ) : (
                <PageEmpty title="还没有表格" description="创建一张表，定义需要保存的记忆结构。" />
              )}
            </>
          ) : null}
        </fieldset>
      </PageContent>
      {state.editor ? (
        <SaveActions
          formId="ste-table-editor"
          busy={state.saving}
          dirty={state.editor.dirty}
          onCancel={back}
          saveAction={`save-${state.editor.kind}`}
        />
      ) : null}
      {confirmation}
      <ConfirmAction
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open) setDeletion(null);
        }}
        title={`删除${deletion?.name ?? ""}${deletion?.kind === "vectors" ? "的向量" : ""}？`}
        description={
          deletion?.kind === "table"
            ? "表格、字段及表内记录将被删除，其他表对这些记录的引用可能失效。此操作无法撤销。"
            : deletion?.kind === "field"
              ? "删除后此字段的数据将不可用；显示策略依赖的字段需要先更换显示策略。此操作无法撤销。"
              : "将清除这张表的向量索引，记忆正文、证据与修订保留。之后需要重新补建才能用于向量检索。"
        }
        confirmLabel="确认删除"
        destructive
        onConfirm={async () => {
          if (deletion?.kind === "vectors") await workspace.index("clear");
          else await workspace.remove(deletion?.fieldId);
          setDeletion(null);
        }}
      />
    </div>
  );
}

function EditorFields({
  state,
  editor,
  onChange,
}: {
  state: TablesSnapshot;
  editor: TableEditor;
  onChange: (editor: TableEditor) => void;
}) {
  if (editor.kind === "table")
    return (
      <>
        <Field>
          <FieldLabel htmlFor="table-name">名称</FieldLabel>
          <Input
            id="table-name"
            required
            value={editor.draft.name}
            onChange={(e) =>
              onChange({ ...editor, draft: { ...editor.draft, name: e.target.value } })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="table-key">Key</FieldLabel>
          <Input
            id="table-key"
            required
            value={editor.draft.key}
            onChange={(e) =>
              onChange({ ...editor, draft: { ...editor.draft, key: e.target.value } })
            }
          />
          <FieldDescription>用于宏、查询和预设匹配，同空间内唯一。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="table-description">描述</FieldLabel>
          <Textarea
            id="table-description"
            value={editor.draft.description}
            onChange={(e) =>
              onChange({ ...editor, draft: { ...editor.draft, description: e.target.value } })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="table-prompt">Prompt</FieldLabel>
          <Textarea
            id="table-prompt"
            value={editor.draft.prompt}
            onChange={(e) =>
              onChange({ ...editor, draft: { ...editor.draft, prompt: e.target.value } })
            }
          />
        </Field>
        {editor.original ? (
          <Field orientation="horizontal">
            <FieldLabel htmlFor="table-enabled">启用表格</FieldLabel>
            <Switch
              id="table-enabled"
              checked={editor.draft.enabled}
              onCheckedChange={(enabled) =>
                onChange({ ...editor, draft: { ...editor.draft, enabled } })
              }
            />
          </Field>
        ) : (
          <FieldDescription>新表创建后默认启用。</FieldDescription>
        )}
      </>
    );
  if (editor.kind === "field") {
    const draft = editor.draft;
    return (
      <>
        <Field>
          <FieldLabel htmlFor="field-name">名称</FieldLabel>
          <Input
            id="field-name"
            required
            value={draft.name}
            onChange={(e) => onChange({ ...editor, draft: { ...draft, name: e.target.value } })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="field-key">Key</FieldLabel>
          <Input
            id="field-key"
            required
            value={draft.key}
            onChange={(e) => onChange({ ...editor, draft: { ...draft, key: e.target.value } })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="field-type">类型</FieldLabel>
          <NativeSelect
            id="field-type"
            disabled={!!editor.original}
            value={draft.type}
            onChange={(e) =>
              onChange({
                ...editor,
                draft: {
                  ...draft,
                  type: e.target.value as typeof draft.type,
                  optionsText: "",
                  referenceTableId: "",
                  maxChars: "",
                  valuePattern: "",
                  valuePatternMessage: "",
                },
              })
            }
          >
            {[
              ["short_text", "短文本"],
              ["long_text", "长文本"],
              ["short_text_list", "短文本列表"],
              ["integer", "整数"],
              ["decimal", "小数"],
              ["boolean", "布尔"],
              ["date", "日期"],
              ["datetime", "日期时间"],
              ["single_select", "单选"],
              ["multi_select", "多选"],
              ["single_reference", "单引用"],
              ["multi_reference", "多引用"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
          {editor.original ? <FieldDescription>字段创建后类型固定。</FieldDescription> : null}
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="field-required">必填</FieldLabel>
          <Switch
            id="field-required"
            checked={draft.required}
            onCheckedChange={(required) => onChange({ ...editor, draft: { ...draft, required } })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="field-enabled">启用</FieldLabel>
          <Switch
            id="field-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ ...editor, draft: { ...draft, enabled } })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="field-prompt">Prompt</FieldLabel>
          <Textarea
            id="field-prompt"
            value={draft.prompt}
            onChange={(e) => onChange({ ...editor, draft: { ...draft, prompt: e.target.value } })}
          />
        </Field>
        {fieldTypeNeedsOptions(draft.type) ? (
          <Field>
            <FieldLabel htmlFor="field-options">固定选项（每行一个）</FieldLabel>
            <Textarea
              id="field-options"
              required
              value={draft.optionsText}
              onChange={(e) =>
                onChange({ ...editor, draft: { ...draft, optionsText: e.target.value } })
              }
            />
          </Field>
        ) : null}
        {fieldTypeNeedsReference(draft.type) ? (
          <Field>
            <FieldLabel htmlFor="field-reference">引用目标表</FieldLabel>
            <NativeSelect
              id="field-reference"
              required
              value={draft.referenceTableId}
              onChange={(e) =>
                onChange({ ...editor, draft: { ...draft, referenceTableId: e.target.value } })
              }
            >
              <option value="">选择表格</option>
              {state.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        {draft.type === "short_text" ||
        draft.type === "long_text" ||
        draft.type === "short_text_list" ? (
          <>
            <Field>
              <FieldLabel htmlFor="field-max">字符数上限</FieldLabel>
              <Input
                id="field-max"
                type="number"
                min="1"
                step="1"
                value={draft.maxChars}
                onChange={(e) =>
                  onChange({ ...editor, draft: { ...draft, maxChars: e.target.value } })
                }
              />
              <FieldDescription>留空表示不限。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="field-pattern">格式校验正则</FieldLabel>
              <Input
                id="field-pattern"
                value={draft.valuePattern}
                onChange={(e) =>
                  onChange({ ...editor, draft: { ...draft, valuePattern: e.target.value } })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="field-pattern-message">格式错误说明</FieldLabel>
              <Textarea
                id="field-pattern-message"
                value={draft.valuePatternMessage}
                onChange={(e) =>
                  onChange({ ...editor, draft: { ...draft, valuePatternMessage: e.target.value } })
                }
              />
            </Field>
          </>
        ) : null}
      </>
    );
  }
  if (editor.kind === "display")
    return (
      <>
        <Field>
          <FieldLabel htmlFor="display-type">显示方式</FieldLabel>
          <NativeSelect
            id="display-type"
            value={editor.draft.type}
            onChange={(e) =>
              onChange({
                ...editor,
                draft: { ...editor.draft, type: e.target.value as "field" | "template" },
              })
            }
          >
            <option value="field">短文本字段</option>
            <option value="template">字段模板</option>
          </NativeSelect>
        </Field>
        {editor.draft.type === "field" ? (
          <Field>
            <FieldLabel htmlFor="display-field">显示字段</FieldLabel>
            <NativeSelect
              id="display-field"
              required
              value={editor.draft.fieldId}
              onChange={(e) =>
                onChange({ ...editor, draft: { ...editor.draft, fieldId: e.target.value } })
              }
            >
              <option value="">选择启用的短文本字段</option>
              {state.fields
                .filter((field) => field.enabled && field.type === "short_text")
                .map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="display-template">显示模板</FieldLabel>
              <Textarea
                id="display-template"
                required
                value={editor.draft.template}
                onChange={(e) =>
                  onChange({ ...editor, draft: { ...editor.draft, template: e.target.value } })
                }
              />
              <FieldDescription>点击字段插入引用；预览使用表内前五条真实记录。</FieldDescription>
            </Field>
            <div className="ste:flex ste:flex-wrap ste:gap-2">
              {state.fields
                .filter((field) => field.enabled)
                .map((field) => (
                  <Button
                    key={field.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onChange({
                        ...editor,
                        draft: {
                          ...editor.draft,
                          template: editor.draft.template + templateFieldRef(field.id),
                        },
                      })
                    }
                  >
                    {field.name}
                  </Button>
                ))}
            </div>
          </>
        )}
      </>
    );
  const draft = editor.draft,
    groups = effectiveVectorIndexGroups(draft, state.fields);
  return (
    <>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="vector-enabled">启用向量索引</FieldLabel>
        <Switch
          id="vector-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => onChange({ ...editor, draft: { ...draft, enabled } })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="vector-source">配置来源</FieldLabel>
        <NativeSelect
          id="vector-source"
          value={draft.source}
          onChange={(e) =>
            onChange({
              ...editor,
              draft: { ...draft, source: e.target.value as typeof draft.source },
            })
          }
        >
          <option value="automatic">自动：全部启用字段</option>
          <option value="preset">预设分组快照</option>
          <option value="custom">自定义分组</option>
        </NativeSelect>
        {draft.source === "preset" ? (
          <FieldDescription>
            使用本表已保存的预设分组。当前页尚未提供从预设库导入分组。
          </FieldDescription>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="vector-update">更新方式</FieldLabel>
        <NativeSelect
          id="vector-update"
          value={draft.updateMode}
          onChange={(e) =>
            onChange({
              ...editor,
              draft: { ...draft, updateMode: e.target.value as typeof draft.updateMode },
            })
          }
        >
          <option value="manual">手动</option>
          <option value="automatic">自动</option>
        </NativeSelect>
      </Field>
      {groups.map((group) => (
        <section key={group.id} className="ste:space-y-3 ste:rounded-2xl ste:border ste:p-4">
          {draft.source === "custom" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`group-name-${group.id}`}>分组名称</FieldLabel>
                <Input
                  id={`group-name-${group.id}`}
                  required
                  value={group.name}
                  onChange={(e) =>
                    onChange({
                      ...editor,
                      draft: {
                        ...draft,
                        groups: draft.groups.map((item) =>
                          item.id === group.id ? { ...item, name: e.target.value } : item,
                        ),
                      },
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`group-key-${group.id}`}>分组 Key</FieldLabel>
                <Input
                  id={`group-key-${group.id}`}
                  required
                  value={group.key}
                  onChange={(e) =>
                    onChange({
                      ...editor,
                      draft: {
                        ...draft,
                        groups: draft.groups.map((item) =>
                          item.id === group.id ? { ...item, key: e.target.value } : item,
                        ),
                      },
                    })
                  }
                />
              </Field>
              <div className="ste:flex ste:flex-col ste:gap-3">
                {state.fields.map((field) => (
                  <label key={field.id} className="ste:flex ste:items-center ste:gap-3">
                    <Checkbox
                      disabled={!field.enabled}
                      checked={group.fieldIds.includes(field.id)}
                      onCheckedChange={(checked) =>
                        onChange({
                          ...editor,
                          draft: {
                            ...draft,
                            groups: draft.groups.map((item) =>
                              item.id === group.id
                                ? {
                                    ...item,
                                    fieldIds: checked
                                      ? [...item.fieldIds, field.id]
                                      : item.fieldIds.filter((id) => id !== field.id),
                                  }
                                : item,
                            ),
                          },
                        })
                      }
                    />
                    {field.name}
                    {!field.enabled ? "（停用）" : ""}
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  onChange({
                    ...editor,
                    draft: {
                      ...draft,
                      groups: draft.groups.filter((item) => item.id !== group.id),
                    },
                  })
                }
              >
                移除分组
              </Button>
            </>
          ) : (
            <>
              <h3 className="ste:font-medium">
                {group.name} · {group.key}
              </h3>
              <p className="ste:text-sm ste:text-muted-foreground">
                {group.fieldIds
                  .map((id) => state.fields.find((field) => field.id === id)?.name ?? id)
                  .join("、")}
              </p>
            </>
          )}
        </section>
      ))}
      {draft.source === "custom" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange({
              ...editor,
              draft: {
                ...draft,
                groups: [
                  ...draft.groups,
                  { id: crypto.randomUUID(), key: "", name: "", fieldIds: [] },
                ],
              },
            })
          }
        >
          <Plus />
          新增分组
        </Button>
      ) : null}
    </>
  );
}
