/**
 * 清洗规则管理器（ticket 22 / ADR 0011）：设置 Tab 的「清洗规则」区块。
 *
 * 纯展示层：列表/规则变更走 cleaning-rule-lists 纯函数 → onChange(nextSettings)
 * （宿主写 settings）；当前对话的选择走 onSelectList（宿主写 chatMetadata）。
 * 结构：
 * - 当前对话使用的清洗列表选择行（未启用 + 全部列表）；
 * - 规则列表管理：列表下拉（编辑目标）+ 新建/重命名/删除 + 规则行
 *   （开关/展开编辑/上下重排/删除）；
 * - 导入：从 ST 全局正则条目（readStRegexScripts 端口）或 ST 导出 JSON 文件，
 *   对话框内勾选条目 + 选目标列表（已有/新建）+ 导入报告。
 */
import { useRef, useState } from "react";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import {
  addCleaningRule,
  createCleaningRuleList,
  moveCleaningRule,
  removeCleaningRule,
  removeCleaningRuleList,
  renameCleaningRuleList,
  updateCleaningRule,
  type CleaningRule,
  type CleaningRuleList,
} from "../settings/cleaning-rule-lists.ts";
import { convertStRegexScripts, type StRegexImportItem } from "../settings/st-regex-import.ts";
import {
  DEFAULT_IMPORT_LIST_NAME,
  applyImportedRules,
  buildStRegexImportReport,
  resolveImportTarget,
  ruleDraftFromRule,
  validateRuleDraft,
  type CleaningRuleDraft,
  type ImportTarget,
  type StRegexImportReport,
} from "./cleaning-rules-manager-model.ts";
import { createUiId, reportError, reportSuccess } from "./ui-helpers.tsx";

const MODE_LABELS: Record<CleaningRule["mode"], string> = {
  keep: "保留",
  discard: "去掉",
  replace: "替换",
};

export function CleaningRulesManager(props: {
  readonly settings: PluginSettings;
  /** 当前对话所选列表 id（undefined = 未启用清洗） */
  readonly selectedListId: string | undefined;
  /** 当前对话选择变更（undefined = 清除选择）；宿主写 chatMetadata */
  readonly onSelectList: (listId: string | undefined) => void;
  /** 宿主写 settings 并更新面板状态 */
  readonly onChange: (settings: PluginSettings) => void;
  /** ST 全局正则条目读取端口（宿主 = getContext().extensionSettings.regex） */
  readonly readStRegexScripts: () => readonly unknown[];
}) {
  const lists = props.settings.cleaningRuleLists;
  // 编辑目标列表：优先当前对话所选；未选择/悬空时取第一个列表
  const [editListId, setEditListId] = useState<string | undefined>(
    props.selectedListId ?? lists[0]?.id,
  );
  const editList = lists.find((list) => list.id === editListId) ?? lists[0];
  // 规则行编辑草稿（展开 + 本地草稿，保存时校验通过才落 settings）
  const [editingRuleId, setEditingRuleId] = useState<string | undefined>(undefined);
  /** 待创建规则 id（+ 添加规则后先编辑、保存才落库；取消则丢弃） */
  const [pendingRuleId, setPendingRuleId] = useState<string | undefined>(undefined);
  const [ruleDraft, setRuleDraft] = useState<CleaningRuleDraft | undefined>(undefined);
  const [ruleError, setRuleError] = useState<string | undefined>(undefined);
  // 导入对话框状态
  const [importOpen, setImportOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<readonly StRegexImportItem[]>([]);
  const [importSelected, setImportSelected] = useState<readonly number[]>([]);
  const [importTarget, setImportTarget] = useState<ImportTarget>({
    kind: "new",
    name: DEFAULT_IMPORT_LIST_NAME,
  });
  const [importReport, setImportReport] = useState<StRegexImportReport | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  function apply(mutate: (current: readonly CleaningRuleList[]) => readonly CleaningRuleList[]): void {
    props.onChange({ ...props.settings, cleaningRuleLists: mutate(lists) });
  }

  function selectEditList(listId: string): void {
    setEditListId(listId);
    setEditingRuleId(undefined);
    setPendingRuleId(undefined);
    setRuleDraft(undefined);
    setRuleError(undefined);
  }

  function createList(): void {
    const name = window.prompt("清洗规则列表名称", "我的清洗列表");
    if (name === null) return;
    const id = createUiId();
    apply((current) => createCleaningRuleList(current, id, name.trim() || "未命名列表"));
    setEditListId(id);
    setImportTarget({ kind: "existing", listId: id });
  }

  function renameList(): void {
    if (!editList) return;
    const name = window.prompt("重命名清洗规则列表", editList.name);
    if (name === null) return;
    apply((current) => renameCleaningRuleList(current, editList.id, name.trim() || editList.name));
  }

  function deleteList(): void {
    if (!editList) return;
    if (!window.confirm(`删除清洗列表「${editList.name}」？引用它的对话将不再清洗。`)) return;
    const deletedId = editList.id;
    apply((current) => removeCleaningRuleList(current, deletedId));
    if (props.selectedListId === deletedId) props.onSelectList(undefined);
    const remaining = lists.filter((list) => list.id !== deletedId);
    setEditListId(remaining[0]?.id);
    setEditingRuleId(undefined);
    setPendingRuleId(undefined);
    setRuleDraft(undefined);
    setRuleError(undefined);
  }

  /** 添加规则：先进入编辑态（草稿），保存校验通过才落库（避免空 pattern 规则入设置）。 */
  function addRule(): void {
    if (!editList) return;
    const id = createUiId();
    setPendingRuleId(id);
    setEditingRuleId(id);
    setRuleDraft({
      name: "新规则",
      mode: "discard",
      pattern: "",
      flags: "g",
      replacement: "",
      enabled: true,
    });
    setRuleError(undefined);
  }

  function beginEdit(rule: CleaningRule): void {
    setEditingRuleId(rule.id);
    setRuleDraft(ruleDraftFromRule(rule));
    setRuleError(undefined);
  }

  function cancelEdit(): void {
    setEditingRuleId(undefined);
    setPendingRuleId(undefined);
    setRuleDraft(undefined);
    setRuleError(undefined);
  }

  function saveEdit(): void {
    if (!editList || !editingRuleId || !ruleDraft) return;
    const error = validateRuleDraft(ruleDraft);
    if (error !== undefined) {
      setRuleError(error);
      return;
    }
    const patch: Partial<CleaningRule> =
      ruleDraft.mode === "replace"
        ? {
            name: ruleDraft.name.trim() || "未命名规则",
            mode: ruleDraft.mode,
            pattern: ruleDraft.pattern,
            flags: ruleDraft.flags,
            enabled: ruleDraft.enabled,
            replacement: ruleDraft.replacement,
          }
        : {
            name: ruleDraft.name.trim() || "未命名规则",
            mode: ruleDraft.mode,
            pattern: ruleDraft.pattern,
            flags: ruleDraft.flags,
            enabled: ruleDraft.enabled,
          };
    if (pendingRuleId === editingRuleId) {
      // 新建路径：校验通过才落库（+ 添加规则 = 编辑草稿，取消不产生空规则）
      const rule: CleaningRule = {
        id: editingRuleId,
        name: ruleDraft.name.trim() || "未命名规则",
        mode: ruleDraft.mode,
        pattern: ruleDraft.pattern,
        flags: ruleDraft.flags,
        enabled: ruleDraft.enabled,
        ...(ruleDraft.mode === "replace" ? { replacement: ruleDraft.replacement } : {}),
      };
      apply((current) => addCleaningRule(current, editList.id, rule));
    } else {
      apply((current) => updateCleaningRule(current, editList.id, editingRuleId, patch));
    }
    setPendingRuleId(undefined);
    cancelEdit();
    reportSuccess("规则已保存");
  }

  function removeRule(ruleId: string): void {
    if (!editList) return;
    apply((current) => removeCleaningRule(current, editList.id, ruleId));
    if (editingRuleId === ruleId) cancelEdit();
  }

  function moveRule(ruleId: string, direction: -1 | 1): void {
    if (!editList) return;
    const index = editList.rules.findIndex((rule) => rule.id === ruleId);
    apply((current) => moveCleaningRule(current, editList.id, ruleId, index + direction));
  }

  // ---- 导入 ----

  function openImportFromSt(): void {
    try {
      const candidates = convertStRegexScripts(props.readStRegexScripts(), createUiId);
      openImportDialog(candidates);
    } catch (error) {
      reportError(error);
    }
  }

  async function openImportFromFile(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    try {
      const candidates = convertStRegexScripts(JSON.parse(text), createUiId);
      openImportDialog(candidates);
    } catch (error) {
      reportError(error);
      return;
    }
  }

  function openImportDialog(candidates: readonly StRegexImportItem[]): void {
    setImportCandidates(candidates);
    setImportSelected(candidates.map((item, index) => (item.kind === "rule" ? index : -1)).filter((i) => i >= 0));
    // 默认目标 = 当前对话所选列表；未选择（或悬空）→ 新建列表（ticket 决策）
    const selected = lists.find((list) => list.id === props.selectedListId);
    setImportTarget(
      selected
        ? { kind: "existing", listId: selected.id }
        : { kind: "new", name: DEFAULT_IMPORT_LIST_NAME },
    );
    setImportReport(null);
    setImportOpen(true);
  }

  function toggleCandidate(index: number): void {
    setImportSelected((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    );
  }

  function confirmImport(): void {
    // 报告 = 选中的规则 + 全部跳过条目（跳过原因确认后仍可见，ticket 决策）
    const selectedRules = importCandidates.filter(
      (item, index) => item.kind === "rule" && importSelected.includes(index),
    );
    const skipped = importCandidates.filter((item) => item.kind === "skipped");
    const report = buildStRegexImportReport([...selectedRules, ...skipped]);
    const target = resolveImportTarget(importTarget);
    if (target.kind === "new") {
      const id = createUiId();
      apply((current) =>
        applyImportedRules(current, { ...target, name: target.name }, selectedRules, () => id),
      );
      setEditListId(id);
      setImportTarget({ kind: "existing", listId: id });
    } else {
      apply((current) => applyImportedRules(current, target, selectedRules, createUiId));
      setEditListId(target.listId);
    }
    setImportReport(report);
    setImportOpen(false);
    reportSuccess(`已导入 ${report.created} 条规则`);
  }

  const importableCount = importCandidates.filter((item) => item.kind === "rule").length;
  const selectedCount = importSelected.length;

  return (
    <div className="stm-setting-group" data-stm-section="cleaning-rules">
      <div className="stm-setting-group-title">清洗规则</div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">当前对话使用的列表</div>
          <div className="stm-setting-hint">
            填表任务输入按所选列表的规则清洗（未启用 = 使用原始消息内容）
          </div>
        </div>
        <select
          className="stm-input"
          data-stm-field="chat-cleaning-list"
          value={props.selectedListId ?? ""}
          onChange={(event) => props.onSelectList(event.target.value === "" ? undefined : event.target.value)}
        >
          <option value="">未启用清洗</option>
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">编辑列表</div>
          <div className="stm-setting-hint">列表内规则按顺序执行（上一条输出是下一条输入）</div>
        </div>
        <select
          className="stm-input"
          data-stm-field="edit-cleaning-list"
          value={editList?.id ?? ""}
          onChange={(event) => selectEditList(event.target.value)}
        >
          {lists.length === 0 && <option value="">（暂无列表）</option>}
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <div className="stm-setting-actions">
        <button type="button" className="stm-button" data-action="create-cleaning-list" onClick={createList}>
          新建列表
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="rename-cleaning-list"
          disabled={!editList}
          onClick={renameList}
        >
          重命名
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="delete-cleaning-list"
          disabled={!editList}
          onClick={deleteList}
        >
          删除列表
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="import-st-regex"
          onClick={openImportFromSt}
        >
          从 ST 正则导入
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="import-st-regex-file"
          onClick={() => importFileInputRef.current?.click()}
        >
          导入文件
        </button>
      </div>
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openImportFromFile(file);
          event.target.value = "";
        }}
      />
      {importReport !== null && (
        <div className="stm-preset-warning" data-stm-field="import-report">
          导入完成：新建 {importReport.created} 条规则
          {importReport.skipped.length > 0 &&
            `，跳过 ${importReport.skipped.length} 条（${importReport.skipped
              .map((item) => `${item.scriptName || "未知"}：${item.reason}`)
              .join("；")}）`}
        </div>
      )}
      {editList === undefined ? (
        <div className="stm-preset-builtin" data-stm-section="cleaning-rules-empty">
          <div className="stm-preset-builtin-text">
            还没有清洗规则列表。从 ST 正则导入已有条目，或新建列表后手动添加规则。
          </div>
        </div>
      ) : (
        <div data-stm-field="cleaning-rule-list">
          {editList.rules.map((rule, index) => (
            <CleaningRuleRow
              key={rule.id}
              rule={rule}
              index={index}
              total={editList.rules.length}
              editing={editingRuleId === rule.id}
              draft={ruleDraft}
              error={ruleError}
              onBeginEdit={() => beginEdit(rule)}
              onCancelEdit={cancelEdit}
              onSaveEdit={saveEdit}
              onDraftChange={setRuleDraft}
              onToggleEnabled={(enabled) =>
                apply((current) => updateCleaningRule(current, editList.id, rule.id, { enabled }))
              }
              onMove={(direction) => moveRule(rule.id, direction)}
              onRemove={() => removeRule(rule.id)}
            />
          ))}
          <button
            type="button"
            className="stm-button stm-preset-add-fragment"
            data-action="add-cleaning-rule"
            onClick={addRule}
          >
            + 添加规则
          </button>
        </div>
      )}
      {importOpen && (
        <ImportDialog
          candidates={importCandidates}
          selected={importSelected}
          importableCount={importableCount}
          selectedCount={selectedCount}
          lists={lists}
          target={importTarget}
          onToggleCandidate={toggleCandidate}
          onTargetChange={setImportTarget}
          onConfirm={confirmImport}
          onCancel={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

/** 规则行：折叠态 = 摘要（开关 + 名称 + 模式 + 正则）；展开态 = 完整表单（保存校验）。 */
function CleaningRuleRow(props: {
  readonly rule: CleaningRule;
  readonly index: number;
  readonly total: number;
  readonly editing: boolean;
  readonly draft: CleaningRuleDraft | undefined;
  readonly error: string | undefined;
  readonly onBeginEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: () => void;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { rule } = props;
  return (
    <div className="stm-preset-fragment" data-stm-field={`cleaning-rule-${rule.id}`}>
      <div className="stm-preset-fragment-head">
        <span className="stm-preset-fragment-index stm-mono">{props.index + 1}</span>
        <label className="stm-switch">
          <input
            type="checkbox"
            data-stm-field={`cleaning-rule-enabled-${rule.id}`}
            checked={rule.enabled}
            onChange={(event) => props.onToggleEnabled(event.target.checked)}
          />
          <span className="stm-switch-track" aria-hidden="true"></span>
        </label>
        <button
          type="button"
          className="stm-preset-fragment-title"
          data-action="edit-cleaning-rule"
          onClick={props.editing ? props.onCancelEdit : props.onBeginEdit}
          title={props.editing ? "收起" : "编辑"}
        >
          <span className="stm-preset-fragment-preview">
            {rule.name} · {MODE_LABELS[rule.mode]}
            {rule.mode === "replace" ? `「${rule.replacement ?? ""}」` : ""}
            <span className="stm-mono">
              {" "}
              /{rule.pattern}/{rule.flags}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="move-cleaning-rule-up"
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
          title="上移"
        >
          ↑
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="move-cleaning-rule-down"
          disabled={props.index >= props.total - 1}
          onClick={() => props.onMove(1)}
          title="下移"
        >
          ↓
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="remove-cleaning-rule"
          onClick={props.onRemove}
          title="删除规则"
        >
          ✕
        </button>
      </div>
      {props.editing && props.draft !== undefined && (
        <CleaningRuleEditor
          draft={props.draft}
          error={props.error}
          onDraftChange={props.onDraftChange}
          onSave={props.onSaveEdit}
          onCancel={props.onCancelEdit}
        />
      )}
    </div>
  );
}

/** 规则编辑表单（草稿非空时渲染；保存校验由父组件执行）。 */
function CleaningRuleEditor(props: {
  readonly draft: CleaningRuleDraft;
  readonly error: string | undefined;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const draft = props.draft;
  return (
    <div className="stm-preset-fragment-body">
      <div className="stm-setting-row">
        <input
          type="text"
          className="stm-input"
          data-stm-field="cleaning-rule-name"
          value={draft.name}
          placeholder="规则名称"
          onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
        />
        <select
          className="stm-input"
          data-stm-field="cleaning-rule-mode"
          value={draft.mode}
          onChange={(event) =>
            props.onDraftChange({ ...draft, mode: event.target.value as CleaningRule["mode"] })
          }
        >
          {(Object.keys(MODE_LABELS) as CleaningRule["mode"][]).map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className="stm-setting-row">
        <input
          type="text"
          className="stm-input stm-mono"
          data-stm-field="cleaning-rule-pattern"
          value={draft.pattern}
          placeholder="正则表达式"
          onChange={(event) => props.onDraftChange({ ...draft, pattern: event.target.value })}
        />
        <input
          type="text"
          className="stm-input stm-mono"
          data-stm-field="cleaning-rule-flags"
          value={draft.flags}
          placeholder="flags（g/i/m/s/u/y）"
          onChange={(event) => props.onDraftChange({ ...draft, flags: event.target.value })}
        />
      </div>
      {draft.mode === "replace" && (
        <input
          type="text"
          className="stm-input stm-mono"
          data-stm-field="cleaning-rule-replacement"
          value={draft.replacement}
          placeholder="替换串（支持 $1 / $<name>）"
          onChange={(event) => props.onDraftChange({ ...draft, replacement: event.target.value })}
        />
      )}
      {props.error !== undefined && (
        <div className="stm-preset-warning" data-stm-field="cleaning-rule-error">
          {props.error}
        </div>
      )}
      <div className="stm-setting-actions">
        <button type="button" className="stm-button" data-action="save-cleaning-rule" onClick={props.onSave}>
          保存
        </button>
        <button type="button" className="stm-button" data-action="cancel-cleaning-rule" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 导入对话框：候选条目勾选 + 目标列表（已有/新建）+ 导入确认。 */
export function ImportDialog(props: {
  readonly candidates: readonly StRegexImportItem[];
  readonly selected: readonly number[];
  readonly importableCount: number;
  readonly selectedCount: number;
  readonly lists: readonly CleaningRuleList[];
  readonly target: ImportTarget;
  readonly onToggleCandidate: (index: number) => void;
  readonly onTargetChange: (target: ImportTarget) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="stm-preset-editor" data-stm-section="regex-import-dialog">
      <div className="stm-setting-group-title">从 ST 正则导入</div>
      {props.importableCount === 0 && props.candidates.length > 0 ? (
        <div className="stm-preset-warning" data-stm-field="import-candidates-empty">
          {props.candidates.map((item) =>
            item.kind === "skipped" ? (
              <div key={item.scriptName}>
                跳过「{item.scriptName || "未知"}」：{item.reason}
              </div>
            ) : null,
          )}
        </div>
      ) : props.candidates.length === 0 ? (
        <div className="stm-preset-warning" data-stm-field="import-candidates-empty">
          没有可导入的正则条目。
        </div>
      ) : (
        <div data-stm-field="import-candidates">
          {props.candidates.map((item, index) =>
            item.kind === "rule" ? (
              <label key={index} className="stm-preset-fragment" data-stm-field={`import-candidate-${index}`}>
                <input
                  type="checkbox"
                  data-action="toggle-import-candidate"
                  checked={props.selected.includes(index)}
                  onChange={() => props.onToggleCandidate(index)}
                />
                <span>
                  {item.rule.name} → {MODE_LABELS[item.rule.mode]}
                  <span className="stm-mono">
                    {" "}
                    /{item.rule.pattern}/{item.rule.flags}
                  </span>
                  {item.notes.length > 0 && (
                    <span className="stm-preset-warning">（{item.notes.join("；")}）</span>
                  )}
                </span>
              </label>
            ) : (
              <div key={index} className="stm-preset-warning">
                跳过「{item.scriptName || "未知"}」：{item.reason}
              </div>
            ),
          )}
        </div>
      )}
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">导入到</div>
        </div>
        <select
          className="stm-input"
          data-stm-field="import-target-list"
          value={props.target.kind === "existing" ? props.target.listId : "__new__"}
          onChange={(event) => {
            if (event.target.value === "__new__") {
              props.onTargetChange({ kind: "new", name: DEFAULT_IMPORT_LIST_NAME });
            } else {
              props.onTargetChange({ kind: "existing", listId: event.target.value });
            }
          }}
        >
          {props.lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
          <option value="__new__">新建列表…</option>
        </select>
      </div>
      {props.target.kind === "new" && (
        <input
          type="text"
          className="stm-input"
          data-stm-field="import-target-name"
          value={props.target.name}
          onChange={(event) => props.onTargetChange({ kind: "new", name: event.target.value })}
        />
      )}
      <div className="stm-setting-actions">
        <button
          type="button"
          className="stm-button"
          data-action="confirm-regex-import"
          disabled={props.selectedCount === 0}
          onClick={props.onConfirm}
        >
          导入{props.selectedCount > 0 ? `（${props.selectedCount} 条）` : ""}
        </button>
        <button type="button" className="stm-button" data-action="cancel-regex-import" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
