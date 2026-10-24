import { useEffect, useRef, useState } from "react";
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
import { Disclosure } from "../shell/disclosure.tsx";
import { Segmented } from "../shell/segmented.tsx";
import { createUiId } from "../shell/ui-helpers.tsx";
import { VectorGroupEditor, type VectorFieldOption } from "./vector-group-editor.tsx";

const emptyConfig: VectorIndexConfiguration = {
  enabled: false,
  source: "automatic",
  updateMode: "manual",
  groups: [],
};

const sourceOptions = [
  { value: "automatic", label: "自动" },
  { value: "preset", label: "预设" },
  { value: "custom", label: "自定义" },
] as const;

const updateOptions = [
  { value: "manual", label: "手动" },
  { value: "automatic", label: "自动" },
] as const;

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
  const initial = props.initial ?? emptyConfig;
  const [draft, setDraft] = useState<VectorIndexConfiguration>(initial);
  const [error, setError] = useState("");
  const [sampleRecords, setSampleRecords] = useState<readonly MemoryRecord[]>([]);
  const [sampleRecordId, setSampleRecordId] = useState("");
  const [samplePreviews, setSamplePreviews] = useState<readonly VectorPreview[]>([]);
  const [sampleError, setSampleError] = useState("");
  const [summary, setSummary] = useState<Awaited<
    ReturnType<VectorIndexService["previewDraftSummary"]>
  > | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [presetId, setPresetId] = useState("");
  const [presetTableKey, setPresetTableKey] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<ReadonlySet<string>>(new Set());
  const errorRef = useRef<HTMLDivElement>(null);

  const debouncedDraft = useDebounced(draft, 220);
  const selectedPreset = props.presets.find((preset) => preset.id === presetId);
  const groups = effectiveVectorIndexGroups(draft, props.fields);
  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));
  const fieldOptions: readonly VectorFieldOption[] = props.fields.map((field) => ({
    id: field.id,
    name: field.name,
    enabled: field.enabled,
  }));

  useEffect(() => {
    props.onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(initial));
  }, [draft, initial, props.onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    void props.records
      .list(props.memorySpaceId, props.tableId, { page: 1, pageSize: 20 })
      .then((page) => {
        if (cancelled) return;
        const records = page?.records ?? [];
        setSampleRecords(records);
        setSampleRecordId(records[0]?.id ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setSampleError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.records, props.memorySpaceId, props.tableId]);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setSummaryError("");
    void props.vector
      .previewDraftSummary(
        { memorySpaceId: props.memorySpaceId, tableId: props.tableId },
        debouncedDraft,
      )
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((cause) => {
        if (!cancelled) setSummaryError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, props.memorySpaceId, props.tableId, debouncedDraft]);

  useEffect(() => {
    if (!previewOpen || !sampleRecordId) return;
    let cancelled = false;
    void props.vector
      .previewDraft(
        {
          memorySpaceId: props.memorySpaceId,
          tableId: props.tableId,
          recordId: sampleRecordId as MemoryRecord["id"],
        },
        debouncedDraft,
      )
      .then((previews) => {
        if (!cancelled) {
          setSamplePreviews(previews);
          setSampleError("");
        }
      })
      .catch((cause) => {
        if (!cancelled) setSampleError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    props.vector,
    props.memorySpaceId,
    props.tableId,
    sampleRecordId,
    previewOpen,
    debouncedDraft,
  ]);

  useEffect(() => {
    if (draft.source !== "preset" || presetId || props.presets.length === 0) return;
    setPresetId(props.presets[0]!.id);
  }, [draft.source, presetId, props.presets]);

  useEffect(() => {
    if (presetTableKey || !selectedPreset) return;
    const first = selectedPreset.tables[0];
    if (first) setPresetTableKey(first.key);
  }, [presetTableKey, selectedPreset]);

  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [error]);

  function changeSource(source: VectorIndexConfiguration["source"]): void {
    if (
      draft.source === "custom" &&
      source !== "custom" &&
      JSON.stringify(draft.groups) !== JSON.stringify(initial.groups) &&
      !window.confirm("自定义分组有未保存修改，切换来源后草稿将丢失，继续吗？")
    )
      return;
    if (source === "custom" && draft.source !== "custom") {
      setDraft({
        ...draft,
        source,
        groups: groups.map((group) => ({ ...group, fieldIds: [...group.fieldIds] })),
      });
    } else {
      setDraft({ ...draft, source, groups: source === "custom" ? draft.groups : [] });
    }
    setError("");
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

  const recordCount = summary?.records;
  const vectorCount = summary?.vectors;
  const pending = summary?.pending ?? 0;
  const legend = summary
    ? (
        [
          { key: "ready", label: "已就绪", count: summary.ready, tone: "success" },
          { key: "pending", label: "待更新", count: summary.pending, tone: "accent" },
          { key: "unavailable", label: "待连接", count: summary.unavailable, tone: "warning" },
          { key: "invalid", label: "失效", count: summary.invalid, tone: "danger" },
          { key: "tooLong", label: "超长", count: summary.tooLong, tone: "danger" },
          { key: "empty", label: "无内容", count: summary.empty, tone: "quiet" },
        ] as const
      ).filter((item) => item.count > 0 || item.key === "ready" || item.key === "pending")
    : [];
  const notices: {
    readonly key: string;
    readonly tone: string;
    readonly icon: string;
    readonly text: string;
  }[] = [];
  if (draft.enabled && summary) {
    if (summary.records === 0) {
      notices.push({ key: "records", tone: "quiet", icon: "fa-inbox", text: "暂无记录" });
    } else if (groups.length === 0) {
      notices.push({
        key: "fields",
        tone: "warning",
        icon: "fa-filter-circle-xmark",
        text: "没有可索引的字段",
      });
    }
    if (summary.unavailable > 0) {
      notices.push({
        key: "connection",
        tone: "warning",
        icon: "fa-plug-circle-xmark",
        text:
          summary.unavailable >= summary.vectors
            ? "未连接 embedding 服务"
            : `${summary.unavailable} 个目标等待连接`,
      });
    }
    if (summary.invalid > 0) {
      notices.push({
        key: "invalid",
        tone: "danger",
        icon: "fa-link-slash",
        text: `${summary.invalid} 个字段已失效`,
      });
    }
    if (summary.tooLong > 0) {
      notices.push({
        key: "tooLong",
        tone: "danger",
        icon: "fa-scissors",
        text: `${summary.tooLong} 个输入超长`,
      });
    }
  }
  const previewChars = samplePreviews.reduce((total, item) => total + item.input.length, 0);
  const hasEnabledField = props.fields.some((field) => field.enabled);

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
        <section className="stm-vector-hero" data-state={draft.enabled ? "on" : "off"}>
          <div className="stm-vector-hero-head">
            <span className="stm-vector-state">
              <span className="stm-vector-state-dot" aria-hidden="true" />
              索引
            </span>
            <label className="stm-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="启用索引"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <span className="stm-switch-track" aria-hidden="true" />
            </label>
          </div>
          <div className="stm-vector-hero-numbers">
            <span>
              <strong>{recordCount ?? "—"}</strong> 条记录
            </span>
            {draft.enabled ? (
              <>
                <i className="fa-solid fa-arrow-right stm-vector-hero-arrow" aria-hidden="true" />
                <span>
                  <strong>{vectorCount ?? "—"}</strong> 个向量
                </span>
                <span className="stm-vector-hero-groups">{groups.length} 组</span>
              </>
            ) : (
              <span className="stm-vector-hero-groups">已关闭</span>
            )}
          </div>
          {draft.enabled && vectorCount !== undefined && vectorCount > 0 ? (
            <>
              <div
                className="stm-vector-meter"
                role="img"
                aria-label={legend.map((item) => `${item.label} ${item.count}`).join("，")}
              >
                {legend
                  .filter((item) => item.count > 0)
                  .map((item) => (
                    <span
                      key={item.key}
                      data-tone={item.tone}
                      style={{ flexGrow: item.count }}
                      aria-hidden="true"
                    />
                  ))}
              </div>
              <ul className="stm-vector-legend">
                {legend.map((item) => (
                  <li
                    key={item.key}
                    data-tone={item.tone}
                    data-idle={item.count === 0 ? "true" : undefined}
                  >
                    <span className="stm-vector-dot" aria-hidden="true" />
                    {item.label} {item.count}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {summaryError ? (
            <p className="stm-vector-hero-note" data-tone="danger" role="status">
              统计失败：{summaryError}
            </p>
          ) : null}
          {notices.length > 0 ? (
            <ul className="stm-vector-notices">
              {notices.map((notice) => (
                <li key={notice.key} data-tone={notice.tone}>
                  <i className={`fa-solid ${notice.icon}`} aria-hidden="true" />
                  {notice.text}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="stm-vector-card stm-vector-card--index">
          <div className="stm-vector-control stm-vector-control--source">
            <span className="stm-vector-label">字段来源</span>
            <Segmented
              label="字段来源"
              value={draft.source}
              options={sourceOptions}
              disabled={props.saving}
              onChange={changeSource}
            />
          </div>

          <div className="stm-vector-source-slot">
            {draft.source === "automatic" ? (
              groups.length > 0 ? (
                <div className="stm-vector-source-view">
                  <div className="stm-vector-summary-head">
                    <span className="stm-vector-summary-name">{groups[0]!.name}</span>
                    <span className="stm-vector-summary-meta">
                      {groups[0]!.fieldIds.length} 字段
                    </span>
                  </div>
                  <div className="stm-vector-chain">
                    {groups[0]!.fieldIds.map((fieldId) => {
                      const field = fieldsById.get(fieldId);
                      return (
                        <span className="stm-vector-chain-item" key={fieldId}>
                          {field?.name ?? "已删除字段"}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="stm-vector-empty" data-tone="warning">
                  没有启用字段
                </div>
              )
            ) : null}

            {draft.source === "preset" ? (
              <div className="stm-vector-preset">
                <div className="stm-vector-import">
                  <label className="stm-vector-import-field">
                    <span className="stm-vector-import-label">预设</span>
                    <select
                      className="stm-input"
                      aria-label="表格预设"
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
                  <label className="stm-vector-import-field">
                    <span className="stm-vector-import-label">表格</span>
                    <select
                      className="stm-input"
                      aria-label="来源表格"
                      value={presetTableKey}
                      disabled={!selectedPreset}
                      onChange={(event) => setPresetTableKey(event.target.value)}
                    >
                      <option value="">选择表格</option>
                      {selectedPreset?.tables.map((table) => (
                        <option key={table.key} value={table.key}>
                          {table.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="stm-button stm-button--primary stm-vector-import-submit"
                    disabled={!presetTableKey}
                    onClick={importPreset}
                  >
                    导入
                  </button>
                </div>
                {draft.presetGroups?.length ? (
                  <div className="stm-vector-source-view">
                    {draft.presetGroups.map((group) => (
                      <div className="stm-vector-summary-group" key={group.id}>
                        <div className="stm-vector-summary-head">
                          <span className="stm-vector-summary-name">{group.name}</span>
                          <span className="stm-vector-summary-meta">
                            {group.fieldIds.length} 字段
                          </span>
                        </div>
                        <div className="stm-vector-chain">
                          {group.fieldIds.map((fieldId) => {
                            const field = fieldsById.get(fieldId);
                            return (
                              <span
                                className="stm-vector-chain-item"
                                data-invalid={!field?.enabled || undefined}
                                key={fieldId}
                              >
                                {field?.name ?? "已删除字段"}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="stm-vector-empty">尚未导入</div>
                )}
              </div>
            ) : null}

            {draft.source === "custom" ? (
              <VectorGroupEditor
                groups={draft.groups}
                fields={fieldOptions}
                disabled={props.saving}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    groups: next as readonly VectorIndexGroup[],
                  })
                }
              />
            ) : null}
          </div>

          <div className="stm-vector-divider" role="separator" />
          <div className="stm-vector-control stm-vector-control--update">
            <div className="stm-vector-label-row">
              <span className="stm-vector-label">更新方式</span>
              <span className="stm-vector-effect" data-tone={draft.updateMode}>
                {draft.updateMode === "automatic"
                  ? pending > 0
                    ? `保存后生成 ${pending} 个`
                    : "已是最新"
                  : "保存后不生成"}
              </span>
            </div>
            <Segmented
              label="更新方式"
              value={draft.updateMode}
              options={updateOptions}
              disabled={props.saving}
              onChange={(updateMode) => setDraft({ ...draft, updateMode })}
            />
          </div>
        </section>

        <div className="stm-vector-preview" ref={previewRef}>
          <Disclosure
            icon="fa-eye"
            title="输入预览"
            meta={
              groups.length > 0
                ? `${groups.length} 组${previewOpen && previewChars > 0 ? ` · ${previewChars} 字符` : ""}`
                : "暂无分组"
            }
            open={previewOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setPreviewOpen(open);
              if (!open) return;
              const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
              requestAnimationFrame(() =>
                previewRef.current?.scrollIntoView({
                  block: "start",
                  behavior: reduced ? "auto" : "smooth",
                }),
              );
            }}
          >
            {sampleRecords.length > 0 ? (
              <label className="stm-vector-sample">
                <span className="stm-vector-sample-label">示例</span>
                <select
                  className="stm-input"
                  aria-label="示例记录"
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
            ) : null}
            {groups.length === 0 ? (
              <div className="stm-vector-empty">
                {hasEnabledField ? "暂无分组" : "没有启用字段"}
              </div>
            ) : (
              groups.map((group) => {
                const preview = samplePreviews.find((item) => item.groupId === group.id);
                const status = preview ? previewStatus(preview) : null;
                const expanded = expandedGroupIds.has(group.id);
                const expandable =
                  (preview?.input.length ?? 0) > 180 ||
                  (preview?.input.split("\n").length ?? 0) > 4;
                return (
                  <section className="stm-vector-sample-group" key={group.id}>
                    <header className="stm-vector-sample-head">
                      <span className="stm-vector-sample-name">{group.name}</span>
                      <span className="stm-vector-sample-size">
                        {preview ? `${preview.input.length} 字符` : ""}
                      </span>
                    </header>
                    <div className="stm-vector-chain stm-vector-chain--small">
                      {group.fieldIds.map((fieldId) => {
                        const field = fieldsById.get(fieldId);
                        return (
                          <span
                            className="stm-vector-chain-item"
                            data-invalid={!field?.enabled || undefined}
                            key={fieldId}
                          >
                            {field?.name ?? "已删除字段"}
                          </span>
                        );
                      })}
                    </div>
                    {preview ? (
                      <pre
                        className="stm-vector-input"
                        data-expanded={expanded ? "true" : undefined}
                      >
                        {preview.input || "（空）"}
                      </pre>
                    ) : (
                      <div className="stm-vector-sample-loading" aria-hidden="true" />
                    )}
                    <div className="stm-vector-sample-foot">
                      {preview ? (
                        status ? (
                          <span className="stm-vector-sample-status" data-tone={status.tone}>
                            {status.text}
                          </span>
                        ) : (
                          <span className="stm-vector-sample-status" data-tone="success">
                            可生成
                          </span>
                        )
                      ) : (
                        <span />
                      )}
                      {expandable && preview ? (
                        <button
                          type="button"
                          className="stm-vector-sample-more"
                          onClick={() =>
                            setExpandedGroupIds((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          {expanded ? "收起" : "展开"}
                        </button>
                      ) : null}
                    </div>
                  </section>
                );
              })
            )}
            {sampleError ? (
              <p className="stm-form-error" role="alert">
                {sampleError}
              </p>
            ) : null}
          </Disclosure>
        </div>

        {error ? (
          <div className="stm-form-error" role="alert" ref={errorRef}>
            {error}
          </div>
        ) : null}
      </fieldset>
      {!props.formId ? (
        <div className="stm-editor-actions">
          <button
            type="button"
            className="stm-button"
            onClick={() => {
              if (
                JSON.stringify(draft) === JSON.stringify(initial) ||
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
            {props.saving ? "保存中…" : "保存"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function previewStatus(
  preview: VectorPreview,
): { readonly text: string; readonly tone: string } | null {
  if (preview.status === "ready") return null;
  if (preview.status === "empty") return { text: "无内容", tone: "quiet" };
  if (preview.status === "unavailable") return { text: "等待连接", tone: "warning" };
  if (preview.status === "too_long")
    return { text: preview.error ?? "超出长度上限", tone: "danger" };
  return { text: preview.error ?? "配置失效", tone: "danger" };
}

function useDebounced<Value>(value: Value, delay: number): Value {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
