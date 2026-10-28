import { Plus } from "lucide-react";
import type { MemoryField, VectorIndexConfiguration } from "../../features/memory/index.ts";
import { effectiveVectorIndexGroups } from "../../features/memory/index.ts";
import { Button } from "../../ui/primitives/button.tsx";
import { Input } from "../../ui/primitives/input.tsx";
import { Textarea } from "../../ui/primitives/textarea.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Switch } from "../../ui/primitives/switch.tsx";
import { Checkbox } from "../../ui/primitives/checkbox.tsx";
import { Field, FieldLabel, FieldDescription } from "../../ui/primitives/field.tsx";
import {
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
} from "../../ui/memory/field-editor-model.ts";
import {
  templateFieldRef,
  type DisplayStrategyDraft,
} from "../../ui/memory/display-strategy-model.ts";
import type { TableDraft, FieldEditorDraft } from "../pages/tables/tables-workspace.ts";

export type SchemaField = Pick<
  MemoryField,
  "id" | "key" | "name" | "type" | "enabled" | "position"
>;
export interface SchemaFieldsState {
  tables: readonly { id: string; name: string }[];
  fields: readonly SchemaField[];
}
export type SchemaEditor =
  | { kind: "table"; original: boolean; draft: TableDraft; dirty: boolean }
  | { kind: "field"; original: boolean; draft: FieldEditorDraft; dirty: boolean }
  | { kind: "display"; draft: DisplayStrategyDraft; dirty: boolean }
  | { kind: "vector"; draft: VectorIndexConfiguration; dirty: boolean };

export function SchemaEditorFields({
  state,
  editor,
  onChange,
  allowVectorSources = true,
  templatePreviewHint = "点击字段插入引用；预览使用表内前五条真实记录。",
}: {
  state: SchemaFieldsState;
  editor: SchemaEditor;
  onChange: (editor: SchemaEditor) => void;
  allowVectorSources?: boolean;
  templatePreviewHint?: string;
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
              <FieldDescription>{templatePreviewHint}</FieldDescription>
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
  const groupProperty = draft.source === "preset" ? "presetGroups" : "groups";
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
      {allowVectorSources ? (
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
              分组按字段 Key 匹配并复制为当前表的快照，预设库后续修改不会自动覆盖。
            </FieldDescription>
          ) : null}
        </Field>
      ) : null}
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
          {draft.source !== "automatic" ? (
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
                        [groupProperty]: (draft[groupProperty] ?? []).map((item) =>
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
                        [groupProperty]: (draft[groupProperty] ?? []).map((item) =>
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
                            [groupProperty]: (draft[groupProperty] ?? []).map((item) =>
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
                      [groupProperty]: (draft[groupProperty] ?? []).filter(
                        (item) => item.id !== group.id,
                      ),
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
      {draft.source !== "automatic" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange({
              ...editor,
              draft: {
                ...draft,
                [groupProperty]: [
                  ...(draft[groupProperty] ?? []),
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
