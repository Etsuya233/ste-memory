import { useEffect, useState } from "react";
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordService,
  MemorySpaceId,
  MemoryTableId,
  VectorIndexConfiguration,
  VectorIndexGroup,
} from "../../features/memory/index.ts";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import type { VectorPreview } from "../../features/vector-index/types.ts";
import {
  effectiveVectorIndexGroups,
  validateVectorIndexConfiguration,
} from "../../features/memory/index.ts";
import type { ResolvedTablePreset } from "../../features/table-presets/preset-model.ts";
import { importPresetVectorIndexGroups } from "../../features/table-presets/preset-vector-index.ts";
import { createUiId } from "../shell/ui-helpers.tsx";

const emptyConfig: VectorIndexConfiguration = {
  enabled: false,
  source: "automatic",
  updateMode: "manual",
  groups: [],
};

export function VectorIndexEditor(props: {
  readonly formId?: string;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly vector: VectorIndexService;
  readonly records: Pick<MemoryRecordService, "list">;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly initial?: VectorIndexConfiguration;
  readonly fields: readonly MemoryField[];
  readonly presets: readonly ResolvedTablePreset[];
  readonly saving: boolean;
  readonly onSave: (config: VectorIndexConfiguration) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<VectorIndexConfiguration>(props.initial ?? emptyConfig);
  useEffect(() => {
    props.onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(props.initial ?? emptyConfig));
  }, [draft, props.initial, props.onDirtyChange]);
  const [error, setError] = useState("");
  const [sampleRecords, setSampleRecords] = useState<readonly MemoryRecord[]>([]);
  const [sampleRecordId, setSampleRecordId] = useState("");
  const [samplePreviews, setSamplePreviews] = useState<readonly VectorPreview[]>([]);
  const [summary, setSummary] = useState<Awaited<
    ReturnType<VectorIndexService["previewDraftSummary"]>
  > | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [presetId, setPresetId] = useState("");
  const [presetTableKey, setPresetTableKey] = useState("");
  const selectedPreset = props.presets.find((preset) => preset.id === presetId);
  const groups = effectiveVectorIndexGroups(draft, props.fields);
  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));

  useEffect(() => {
    let cancelled = false;
    void props.records
      .list(props.memorySpaceId, props.tableId, { page: 1, pageSize: 20 })
      .then((page) => {
        if (!cancelled) {
          const records = page?.records ?? [];
          setSampleRecords(records);
          setSampleRecordId(records[0]?.id ?? "");
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.records, props.memorySpaceId, props.tableId]);

  useEffect(() => {
    if (!sampleRecordId) {
      setSamplePreviews([]);
      return;
    }
    let cancelled = false;
    void props.vector
      .previewDraft(
        {
          memorySpaceId: props.memorySpaceId,
          tableId: props.tableId,
          recordId: sampleRecordId as MemoryRecord["id"],
        },
        draft,
      )
      .then((previews) => {
        if (!cancelled) setSamplePreviews(previews);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, props.memorySpaceId, props.tableId, sampleRecordId, draft]);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setSummaryError("");
    void props.vector
      .previewDraftSummary({ memorySpaceId: props.memorySpaceId, tableId: props.tableId }, draft)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((cause) => {
        if (!cancelled) setSummaryError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, props.memorySpaceId, props.tableId, draft]);

  function changeSource(source: VectorIndexConfiguration["source"]): void {
    if (
      draft.source === "custom" &&
      source !== "custom" &&
      JSON.stringify(draft.groups) !== JSON.stringify(props.initial?.groups ?? []) &&
      !window.confirm("自定义分组有未保存修改，切换来源后草稿将丢失，继续吗？")
    )
      return;
    if (source === "custom" && draft.source !== "custom") {
      setDraft({
        ...draft,
        source,
        groups: groups.map((group) => ({
          ...group,
          fieldIds: [...group.fieldIds],
        })),
      });
    } else {
      setDraft({ ...draft, source, groups: source === "custom" ? draft.groups : [] });
    }
    setError("");
  }

  function updateGroup(id: string, change: (group: VectorIndexGroup) => VectorIndexGroup): void {
    setDraft({
      ...draft,
      groups: draft.groups.map((group) => (group.id === id ? change(group) : group)),
    });
  }

  function importPreset(): void {
    try {
      const table = selectedPreset?.tables.find((item) => item.key === presetTableKey);
      if (!table) throw new Error("请选择预设和来源表格");
      const presetGroups = importPresetVectorIndexGroups(table, props.fields, createUiId);
      setDraft({ ...draft, source: "preset", groups: [], presetGroups });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function save(): Promise<void> {
    try {
      const configuration = draft.source === "custom" ? draft : { ...draft, groups: [] };
      validateVectorIndexConfiguration(configuration, props.fields);
      await props.onSave(configuration);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <form
      id={props.formId}
      className="stm-editor stm-vector-editor"
      data-stm-section="vector-index-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.saving) void save();
      }}
    >
      <fieldset className="stm-editor-fields" disabled={props.saving}>
        {!props.formId ? <div className="stm-editor-title">向量索引配置</div> : null}
        <p className="stm-setting-hint">
          选中的字段文本会发送到设置中的 embedding
          端点。配置来源决定字段组合，更新方式决定何时提交请求。已提交的任务会继续执行，可到任务页取消。
        </p>
        <label className="stm-form-row">
          <span className="stm-form-label">启用索引</span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
        </label>
        <label className="stm-form-row">
          <span className="stm-form-label">配置来源</span>
          <select
            className="stm-input"
            value={draft.source}
            onChange={(event) =>
              changeSource(event.target.value as VectorIndexConfiguration["source"])
            }
          >
            <option value="automatic">自动配置</option>
            <option value="preset">使用预设配置</option>
            <option value="custom">自定义配置</option>
          </select>
        </label>
        <label className="stm-form-row">
          <span className="stm-form-label">更新方式</span>
          <select
            className="stm-input"
            value={draft.updateMode}
            onChange={(event) =>
              setDraft({
                ...draft,
                updateMode: event.target.value as VectorIndexConfiguration["updateMode"],
              })
            }
          >
            <option value="manual">手动更新</option>
            <option value="automatic">自动更新</option>
          </select>
        </label>
        {draft.source === "automatic" && (
          <p className="stm-setting-hint">
            全部启用业务字段按表格顺序组成一组。保存后字段变化会动态调整；手动更新时仍需点击向量化。
          </p>
        )}
        {draft.source === "preset" && (
          <div className="stm-vector-import">
            {!draft.presetGroups?.length && (
              <p className="stm-setting-hint">尚无预设配置，请从表格预设导入。</p>
            )}
            <label className="stm-form-row">
              <span className="stm-form-label">从表格预设导入配置</span>
              <select
                className="stm-input"
                value={presetId}
                onChange={(event) => {
                  setPresetId(event.target.value);
                  setPresetTableKey("");
                }}
              >
                <option value="">选择预设</option>
                {props.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedPreset && (
              <label className="stm-form-row">
                <span className="stm-form-label">来源表格</span>
                <select
                  className="stm-input"
                  value={presetTableKey}
                  onChange={(event) => setPresetTableKey(event.target.value)}
                >
                  <option value="">选择表格</option>
                  {selectedPreset.tables.map((table) => (
                    <option key={table.key} value={table.key}>
                      {table.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="stm-button" onClick={importPreset}>
              导入到草稿
            </button>
            <p className="stm-setting-hint">
              仅按字段 Key 精确匹配。导入成功后保存为本表独立快照，不改变表结构或更新方式。
            </p>
          </div>
        )}
        {draft.source === "custom" && (
          <div className="stm-vector-groups">
            {draft.groups.map((group, index) => (
              <div className="stm-vector-group" key={group.id}>
                <div className="stm-vector-group-head">
                  <input
                    className="stm-input"
                    aria-label={`分组 ${index + 1} 名称`}
                    value={group.name}
                    onChange={(event) =>
                      updateGroup(group.id, (old) => ({ ...old, name: event.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="stm-table-action"
                    disabled={index === 0}
                    onClick={() =>
                      setDraft({ ...draft, groups: moveGroup(draft.groups, index, -1) })
                    }
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    disabled={index === draft.groups.length - 1}
                    onClick={() =>
                      setDraft({ ...draft, groups: moveGroup(draft.groups, index, 1) })
                    }
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="stm-table-action stm-table-action--danger"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        groups: draft.groups.filter((item) => item.id !== group.id),
                      })
                    }
                  >
                    删除组
                  </button>
                </div>
                <div className="stm-vector-fields">
                  {group.fieldIds.map((fieldId, fieldIndex) => {
                    const field = fieldsById.get(fieldId);
                    return (
                      <div className="stm-vector-field" key={`${fieldId}-${fieldIndex}`}>
                        <span className={field?.enabled ? "" : "stm-form-error"}>
                          {field
                            ? `${field.name}${field.enabled ? "" : "（已停用）"}`
                            : `已删除字段 ${fieldId}`}
                        </span>
                        <button
                          type="button"
                          className="stm-table-action"
                          disabled={fieldIndex === 0}
                          onClick={() =>
                            updateGroup(group.id, (old) => ({
                              ...old,
                              fieldIds: moveGroup(old.fieldIds, fieldIndex, -1),
                            }))
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="stm-table-action"
                          disabled={fieldIndex === group.fieldIds.length - 1}
                          onClick={() =>
                            updateGroup(group.id, (old) => ({
                              ...old,
                              fieldIds: moveGroup(old.fieldIds, fieldIndex, 1),
                            }))
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="stm-table-action stm-table-action--danger"
                          onClick={() =>
                            updateGroup(group.id, (old) => ({
                              ...old,
                              fieldIds: old.fieldIds.filter((_, i) => i !== fieldIndex),
                            }))
                          }
                        >
                          移除
                        </button>
                      </div>
                    );
                  })}
                </div>
                <select
                  className="stm-input"
                  aria-label={`给 ${group.name} 添加字段`}
                  value=""
                  onChange={(event) =>
                    updateGroup(group.id, (old) => ({
                      ...old,
                      fieldIds: [...old.fieldIds, event.target.value as MemoryField["id"]],
                    }))
                  }
                >
                  <option value="">添加字段</option>
                  {props.fields
                    .filter((field) => field.enabled && !group.fieldIds.includes(field.id))
                    .map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                </select>
              </div>
            ))}
            <button
              type="button"
              className="stm-button"
              onClick={() =>
                setDraft({
                  ...draft,
                  groups: [
                    ...draft.groups,
                    { id: createUiId(), name: `分组 ${draft.groups.length + 1}`, fieldIds: [] },
                  ],
                })
              }
            >
              新增分组
            </button>
            <p className="stm-setting-hint">
              同一个字段可用于多个分组。组内字段按上方顺序组成输入。
            </p>
          </div>
        )}
        <div className="stm-vector-preview">
          <strong>整表存量范围（草稿）</strong>
          {summary ? (
            <p>
              整表记录 {summary.records} 条 · 目标向量 {summary.vectors} 个 · 可复用 {summary.ready}
              个 · 待生成目标 {summary.pending} 个 · 无内容 {summary.empty} 个 · 配置失效{" "}
              {summary.invalid}个 · 超长 {summary.tooLong} 个 · 待连接 {summary.unavailable} 个
            </p>
          ) : summaryError ? (
            <p className="stm-form-error" role="alert">
              整表范围统计失败：{summaryError}
            </p>
          ) : (
            <p>正在统计整表范围…</p>
          )}
          <p className="stm-setting-hint">
            当前仅统计草稿，不发送请求。
            {!draft.enabled
              ? "索引已停用，保存仅保留配置；上述范围仅供预览。"
              : draft.updateMode === "automatic"
                ? "保存后将按上述范围自动创建向量任务，遵守任务去重和取消、失败抑制规则；可复用的向量不重复生成，无内容不发送请求。"
                : "手动更新模式保存不发送请求，需在保存后手动提交向量化任务。"}
          </p>
          <strong>分组与输入预览（草稿）</strong>
          {sampleRecords.length > 0 && (
            <label className="stm-form-row">
              <span className="stm-form-label">示例记录</span>
              <select
                className="stm-input"
                value={sampleRecordId}
                onChange={(event) => setSampleRecordId(event.target.value)}
              >
                {sampleRecords.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.displayText}
                  </option>
                ))}
              </select>
            </label>
          )}
          {groups.length === 0 ? (
            <p>暂无可用字段</p>
          ) : (
            groups.map((group) => (
              <div className="stm-vector-preview-group" key={group.id}>
                <strong>{group.name}</strong>
                <div>
                  {group.fieldIds
                    .map((id) => {
                      const field = fieldsById.get(id);
                      return field
                        ? `${field.name}${field.enabled ? "" : "（已停用，配置失效）"}`
                        : `已删除字段 ${id}（配置失效）`;
                    })
                    .join(" → ")}
                </div>
                {sampleRecordId ? (
                  <>
                    <pre>
                      {samplePreviews.find((preview) => preview.groupId === group.id)?.input ||
                        "（无内容）"}
                    </pre>
                    <div className="stm-setting-hint">
                      {(() => {
                        const preview = samplePreviews.find((item) => item.groupId === group.id);
                        return preview
                          ? `${preview.input.length} 字符 · ${preview.status === "too_long" || preview.status === "configuration_invalid" ? preview.error : preview.status === "empty" ? "无内容，不发请求" : preview.status === "unavailable" ? "等待连接" : "未超出连接字符上限"}`
                          : "正在计算预览";
                      })()}
                    </div>
                  </>
                ) : (
                  <pre>
                    {group.fieldIds
                      .map((id) => fieldsById.get(id))
                      .filter((field) => field?.enabled)
                      .map((field) => `${field!.name}：〈字段值〉`)
                      .join("\n")}
                  </pre>
                )}
              </div>
            ))
          )}
          <p className="stm-setting-hint">
            {sampleRecordId
              ? "预览使用当前草稿与已保存的示例记录，不发送请求。"
              : "尚无记录，字段值与长度需在创建记录后预览。"}
          </p>
        </div>
        {error && (
          <div className="stm-form-error" role="alert">
            {error}
          </div>
        )}
      </fieldset>
      {!props.formId ? (
        <div className="stm-editor-actions">
          <button
            type="button"
            className="stm-button"
            onClick={() => {
              if (
                JSON.stringify(draft) === JSON.stringify(props.initial ?? emptyConfig) ||
                window.confirm("向量配置有未保存修改，放弃草稿吗？")
              )
                props.onCancel();
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="stm-button stm-button--primary"
            disabled={props.saving}
            onClick={() => void save()}
          >
            {props.saving ? "保存中…" : "保存向量配置"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function moveGroup<T>(items: readonly T[], index: number, delta: number): T[] {
  const next = [...items];
  [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
  return next;
}
