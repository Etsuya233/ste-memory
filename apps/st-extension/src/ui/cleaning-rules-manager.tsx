/**
 * 清洗规则管理器（ticket 22 / ADR 0011）：设置 Tab 的「清洗规则」区块。
 *
 * 纯展示层：列表/规则变更走 cleaning-rule-lists 纯函数 → onChange(nextSettings)
 * （宿主写 settings）；当前对话的选择走 onSelectList（宿主写 chatMetadata）。
 * 结构：
 * - 当前对话使用的清洗列表选择行（未启用 + 全部列表）；
 * - 规则列表管理：列表下拉（编辑目标）+ 新建/重命名/删除 + 规则行
 *   （开关/展开编辑/上下重排/删除）；
 * - 导入：从 ST 正则条目（readStRegexEntries 端口：全局 + 当前角色卡 + 当前预设）
 *   或 ST 导出 JSON 文件，对话框内勾选条目 + 选目标列表（已有/新建）+ 导入报告。
 */
import { useRef, useState } from "react";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { FillSourceMessage } from "../fill-tasks/fill-task.ts";
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
import type { StRegexEntry, StRegexEntrySource } from "../st/st-chat-adapter.ts";
import {
  DEFAULT_IMPORT_LIST_NAME,
  applyImportedRules,
  buildStRegexImportReport,
  draftToRule,
  resolveImportTarget,
  ruleDraftFromRule,
  runCleaningTest,
  validateRuleDraft,
  type CleaningRuleDraft,
  type CleaningTestMessage,
  type CleaningTestRun,
  type ImportTarget,
  type StRegexImportReport,
} from "./cleaning-rules-manager-model.ts";
import { copyText, createUiId, reportError, reportSuccess } from "./ui-helpers.tsx";

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
  /** ST 正则条目读取端口（宿主 = getContext()：全局 + 当前角色卡 + 当前预设） */
  readonly readStRegexEntries: () => readonly StRegexEntry[];
  /** 最近 N 条对话消息读取端口（宿主 = 与填表任务同源的楼层读取，ticket 27） */
  readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
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
  /** 候选条目来源（与 importCandidates 下标一一对应；文件导入全为 file） */
  const [importSources, setImportSources] = useState<readonly StRegexEntrySource[]>([]);
  const [importSelected, setImportSelected] = useState<readonly number[]>([]);
  const [importTarget, setImportTarget] = useState<ImportTarget>({
    kind: "new",
    name: DEFAULT_IMPORT_LIST_NAME,
  });
  const [importReport, setImportReport] = useState<StRegexImportReport | null>(null);
  // 清洗测试弹窗状态（ticket 27）：打开时快照规则与草稿（遮罩盖住面板，生命周期内不变）
  const [testOpen, setTestOpen] = useState(false);
  const [testForm, setTestForm] = useState<"text" | "messages">("text");
  const [testText, setTestText] = useState("");
  const [testMessages, setTestMessages] = useState<readonly CleaningTestMessage[]>([]);
  const [testResult, setTestResult] = useState<CleaningTestRun | undefined>(undefined);
  const [testLoadHint, setTestLoadHint] = useState<string | null>(null);
  const [testSnapshot, setTestSnapshot] = useState<
    | { readonly rules: readonly CleaningRule[]; readonly draftOverrides: ReadonlyMap<string, CleaningRuleDraft> }
    | null
  >(null);

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

  // ---- 清洗测试（ticket 27）----

  /** 打开弹窗：快照当前编辑列表与未保存草稿（编辑中规则覆盖/新建草稿追加，模型处理）。 */
  function openTest(): void {
    if (!editList) return;
    setTestSnapshot({
      rules: editList.rules,
      draftOverrides:
        editingRuleId !== undefined && ruleDraft !== undefined ? new Map([[editingRuleId, ruleDraft]]) : new Map(),
    });
    setTestForm("text");
    setTestText("");
    setTestMessages([]);
    setTestResult(undefined);
    setTestLoadHint(null);
    setTestOpen(true);
  }

  /** 运行：单条文本形态 = 一条无名消息，与消息列表共用逐条执行模型。 */
  function runTest(): void {
    const snapshot = testSnapshot;
    if (!snapshot) return;
    const messages =
      testForm === "text" ? [{ name: "", content: testText }] : testMessages;
    setTestResult(runCleaningTest(snapshot.rules, snapshot.draftOverrides, messages));
  }

  /** 载入当前对话最近 20 条（对齐填表任务默认块大小）；无消息提示且不切换形态。 */
  function loadTestMessages(): void {
    const loaded = props.readRecentMessages(20);
    if (loaded.length === 0) {
      setTestLoadHint("当前对话没有消息");
      return;
    }
    setTestMessages(loaded.map((message) => ({ name: message.name, content: message.content })));
    setTestForm("messages");
    setTestLoadHint(null);
    setTestResult(undefined); // 切换输入形态后旧结果失效（消息条数不再对应）
  }

  /** 复制结果（多消息 = 逐条拼接，名字非空时前缀「名字：」与展示一致）。 */
  function copyTestResult(): void {
    if (testResult?.kind !== "ok") return;
    const lines = testResult.messages.map((message) =>
      message.name === "" ? message.output : `${message.name}：${message.output}`,
    );
    copyText(lines.join("\n"));
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
    // 草稿 → 规则（形状统一由模型层 draftToRule 负责；仅名字归一化在此）
    const rule = { ...draftToRule(ruleDraft, editingRuleId), name: ruleDraft.name.trim() || "未命名规则" };
    if (pendingRuleId === editingRuleId) {
      // 新建路径：校验通过才落库（+ 添加规则 = 编辑草稿，取消不产生空规则）
      apply((current) => addCleaningRule(current, editList.id, rule));
    } else {
      const { id: _id, ...patch } = rule;
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
      const entries = props.readStRegexEntries();
      const candidates = convertStRegexScripts(
        entries.map((entry) => entry.script),
        createUiId,
      );
      openImportDialog(candidates, entries.map((entry) => entry.source));
    } catch (error) {
      reportError(error);
    }
  }

  /** 从 ST 导出的 JSON 文件导入候选（替换对话框内候选列表，对话框保持打开） */
  async function importFileIntoDialog(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    try {
      const candidates = convertStRegexScripts(JSON.parse(text), createUiId);
      setImportCandidates(candidates);
      setImportSources(candidates.map(() => "file" as const));
      // 文件导入同样默认不勾选（用户手动选择）
      setImportSelected([]);
      setImportReport(null);
    } catch (error) {
      reportError(error);
      return;
    }
  }

  function openImportDialog(
    candidates: readonly StRegexImportItem[],
    sources: readonly StRegexEntrySource[],
  ): void {
    setImportCandidates(candidates);
    setImportSources(sources);
    // 默认不勾选（用户手动选择要导入的条目）；默认目标 = 当前编辑列表
    setImportSelected([]);
    // 无列表时新建（名称可在对话框内修改）
    setImportTarget(
      editList ? { kind: "existing", listId: editList.id } : { kind: "new", name: DEFAULT_IMPORT_LIST_NAME },
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
          data-action="test-cleaning-list"
          disabled={!editList}
          onClick={openTest}
        >
          测试
        </button>
      </div>
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
            还没有清洗规则列表。点击「导入正则」从 ST 的正则条目（全局 / 当前角色卡 /
            当前预设）导入，或先新建列表后手动添加规则。
          </div>
          <button
            type="button"
            className="stm-button"
            data-action="import-st-regex"
            onClick={openImportFromSt}
          >
            导入正则
          </button>
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
              onToggleEnabled={(enabled) => {
                // 开关同时写入已保存规则与编辑草稿：编辑中点测试/保存时 enabled 不漂移
                apply((current) => updateCleaningRule(current, editList.id, rule.id, { enabled }));
                setRuleDraft((current) => (current ? { ...current, enabled } : current));
              }}
              onMove={(direction) => moveRule(rule.id, direction)}
              onRemove={() => removeRule(rule.id)}
            />
          ))}
          {/* 新建草稿行：未保存前不落库，编辑态即时可见（取消/切列表即丢弃） */}
          {pendingRuleId !== undefined && ruleDraft !== undefined && (
            <CleaningRuleRow
              key={pendingRuleId}
              rule={draftToRule(ruleDraft, pendingRuleId)}
              index={editList.rules.length}
              total={editList.rules.length + 1}
              editing
              movable={false}
              draft={ruleDraft}
              error={ruleError}
              onBeginEdit={() => undefined}
              onCancelEdit={cancelEdit}
              onSaveEdit={saveEdit}
              onDraftChange={setRuleDraft}
              onToggleEnabled={(enabled) =>
                setRuleDraft((current) => (current ? { ...current, enabled } : current))
              }
              onMove={() => undefined}
              onRemove={() => undefined}
            />
          )}
          <div className="stm-setting-actions">
            <button
              type="button"
              className="stm-button stm-preset-add-fragment"
              data-action="add-cleaning-rule"
              onClick={addRule}
            >
              + 添加规则
            </button>
            <button
              type="button"
              className="stm-button"
              data-action="import-st-regex"
              onClick={openImportFromSt}
            >
              导入正则
            </button>
          </div>
        </div>
      )}
      {importOpen && (
        <ImportDialog
          candidates={importCandidates}
          sources={importSources}
          selected={importSelected}
          importableCount={importableCount}
          selectedCount={selectedCount}
          target={importTarget}
          targetListName={editList?.name ?? ""}
          onToggleCandidate={toggleCandidate}
          onTargetChange={setImportTarget}
          onImportFile={(file) => void importFileIntoDialog(file)}
          onConfirm={confirmImport}
          onCancel={() => setImportOpen(false)}
        />
      )}
      {testOpen && testSnapshot !== null && (
        <CleaningTestDialog
          form={testForm}
          text={testText}
          messages={testMessages}
          result={testResult}
          hasDraftOverrides={testSnapshot.draftOverrides.size > 0}
          loadHint={testLoadHint}
          onTextChange={setTestText}
          onMessageChange={(index, patch) =>
            setTestMessages((current) =>
              current.map((message, i) => (i === index ? { ...message, ...patch } : message)),
            )
          }
          onLoadMessages={loadTestMessages}
          onRun={runTest}
          onCopy={copyTestResult}
          onClose={() => setTestOpen(false)}
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
  /** 是否可重排（新建草稿行未落库，隐藏上下移按钮） */
  readonly movable?: boolean;
  readonly onBeginEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: () => void;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { rule } = props;
  const movable = props.movable ?? true;
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
        {movable && (
          <>
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
          </>
        )}
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

/** 条目来源标签（st-chat-adapter StRegexEntrySource）。 */
const SOURCE_LABELS: Record<StRegexEntrySource, string> = {
  global: "全局",
  scoped: "角色",
  preset: "预设",
  file: "文件",
};

/** 清洗测试弹窗（ticket 27）：对当前编辑列表整条流水线的预览工具。
 * 纯投影：输入/执行/复制全部经回调交给父组件（含未保存草稿快照）。 */
export function CleaningTestDialog(props: {
  readonly form: "text" | "messages";
  readonly text: string;
  readonly messages: readonly CleaningTestMessage[];
  /** 最近一次运行结果（未运行过 = undefined） */
  readonly result: CleaningTestRun | undefined;
  /** 是否有未保存草稿参与本次测试（「含未保存修改」标注） */
  readonly hasDraftOverrides: boolean;
  /** 载入对话无消息提示（null = 无提示） */
  readonly loadHint: string | null;
  readonly onTextChange: (text: string) => void;
  readonly onMessageChange: (index: number, patch: Partial<CleaningTestMessage>) => void;
  readonly onLoadMessages: () => void;
  readonly onRun: () => void;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}) {
  const hasResult = props.result !== undefined;
  return (
    <div className="stm-modal-overlay" data-stm-section="cleaning-test-dialog" onClick={props.onClose}>
      <div
        className="stm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="清洗测试"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="stm-modal-title" data-stm-field="cleaning-test-title">
          清洗测试
        </div>
        <div className="stm-modal-body">
          <div className="stm-setting-row">
            <div className="stm-setting-label">
              <div className="stm-setting-name">测试输入</div>
              <div className="stm-setting-hint">
                {props.form === "text"
                  ? "整框视为一条消息内容（与填表任务逐条清洗一致）"
                  : `最近对话消息逐条清洗（${props.messages.length} 条，只清洗内容）`}
              </div>
            </div>
            <button
              type="button"
              className="stm-button"
              data-action="load-chat-messages"
              onClick={props.onLoadMessages}
            >
              从当前对话载入
            </button>
          </div>
          {props.form === "text" ? (
            <textarea
              className="stm-input stm-mono stm-modal-textarea"
              data-stm-field="cleaning-test-input"
              value={props.text}
              placeholder="粘贴要测试的消息内容…"
              onChange={(event) => props.onTextChange(event.target.value)}
            />
          ) : (
            <div data-stm-field="cleaning-test-messages">
              {props.messages.map((message, index) => (
                <div key={index} data-stm-field={`cleaning-test-message-${index}`}>
                  <div className="stm-setting-row">
                    <span className="stm-preset-fragment-index stm-mono">{index + 1}</span>
                    <input
                      type="text"
                      className="stm-input"
                      data-stm-field={`cleaning-test-message-name-${index}`}
                      value={message.name}
                      placeholder="发送者名"
                      onChange={(event) => props.onMessageChange(index, { name: event.target.value })}
                    />
                  </div>
                  <textarea
                    className="stm-input stm-mono stm-modal-textarea"
                    data-stm-field={`cleaning-test-message-content-${index}`}
                    value={message.content}
                    placeholder="消息内容（仅内容参与清洗）"
                    onChange={(event) => props.onMessageChange(index, { content: event.target.value })}
                  />
                </div>
              ))}
            </div>
          )}
          {props.hasDraftOverrides && (
            <div className="stm-preset-warning" data-stm-field="cleaning-test-draft-hint">
              含未保存修改：编辑中的规则草稿已参与本次测试
            </div>
          )}
          {props.loadHint !== null && (
            <div className="stm-preset-warning" data-stm-field="cleaning-test-load-hint">
              {props.loadHint}
            </div>
          )}
          {props.result !== undefined && props.result.kind === "error" && (
            <div className="stm-preset-warning" data-stm-field="cleaning-test-error">
              {props.result.errors.join("；")}
            </div>
          )}
          {props.result !== undefined && props.result.kind === "ok" && (
            <div data-stm-field="cleaning-test-result">
              {!props.result.anyActiveRule && (
                <div className="stm-preset-warning" data-stm-field="cleaning-test-no-active-rule">
                  列表没有启用规则，结果为原文
                </div>
              )}
              {props.result.messages.map((message, index) => (
                <div
                  key={index}
                  className="stm-preset-fragment"
                  data-stm-field={`cleaning-test-message-result-${index}`}
                >
                  <div className="stm-preset-fragment-head">
                    <span className="stm-preset-fragment-index stm-mono">{index + 1}</span>
                    <span className="stm-preset-fragment-preview">
                      {message.name === "" ? "（无名消息）" : `名字：${message.name}`}
                    </span>
                  </div>
                  <div className="stm-preset-fragment-body">
                    <div className="stm-setting-hint">原文</div>
                    <pre className="stm-mono stm-modal-text">{renderCleaningText(message.input)}</pre>
                    <div className="stm-setting-hint">步骤</div>
                    <ol data-stm-field={`cleaning-test-steps-${index}`}>
                      {message.steps.map((step, stepIndex) => (
                        <li key={step.ruleId} data-stm-field={`cleaning-test-step-${stepIndex}`}>
                          <span className="stm-mono">
                            {step.ruleName} · {MODE_LABELS[step.mode]}
                          </span>
                          {step.fromDraft && <span className="stm-chip">草稿</span>}
                          {step.active ? (
                            <pre className="stm-mono stm-modal-text">{renderCleaningText(step.output)}</pre>
                          ) : (
                            <span className="stm-setting-hint">跳过（已停用）</span>
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="stm-setting-hint">最终结果</div>
                    <pre className="stm-mono stm-modal-text">{renderCleaningText(message.output)}</pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="stm-modal-footer">
          <button type="button" className="stm-button" data-action="run-cleaning-test" onClick={props.onRun}>
            清洗
          </button>
          <button
            type="button"
            className="stm-button"
            data-action="copy-cleaning-test"
            disabled={!hasResult || props.result?.kind !== "ok"}
            onClick={props.onCopy}
          >
            复制结果
          </button>
          <button type="button" className="stm-button" data-action="close-cleaning-test" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 空内容统一显示「（空）」（PreviewModal 先例）。 */
function renderCleaningText(content: string): string {
  return content === "" ? "（空）" : content;
}

/** 导入对话框：来源（ST 全局/角色卡/预设 + 文件）+ 候选勾选（默认不选）+ 导入确认。
 * 目标列表 = 当前编辑列表（无列表时新建并填名），无需选择。 */
export function ImportDialog(props: {
  readonly candidates: readonly StRegexImportItem[];
  /** 候选来源（与 candidates 下标一一对应） */
  readonly sources: readonly StRegexEntrySource[];
  readonly selected: readonly number[];
  readonly importableCount: number;
  readonly selectedCount: number;
  /** 导入目标：已有列表名（existing 时）或新建名称（new 时） */
  readonly target: ImportTarget;
  readonly targetListName: string;
  readonly onToggleCandidate: (index: number) => void;
  readonly onTargetChange: (target: ImportTarget) => void;
  /** 从 ST 导出的 JSON 文件导入候选（替换候选列表，对话框保持打开） */
  readonly onImportFile: (file: File) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="stm-preset-editor" data-stm-section="regex-import-dialog">
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">导入正则</div>
          <div className="stm-setting-hint">
            列出 ST 的全局、当前角色卡与当前预设中的正则条目；勾选后导入到当前列表
          </div>
        </div>
        <button
          type="button"
          className="stm-button"
          data-action="import-st-regex-file"
          onClick={() => fileInputRef.current?.click()}
        >
          从文件导入…
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) props.onImportFile(file);
          event.target.value = "";
        }}
      />
      {props.candidates.length === 0 ? (
        <div className="stm-preset-warning" data-stm-field="import-candidates-empty">
          ST 中暂无正则条目（全局 / 当前角色卡 / 当前预设）。可先在 ST 的 Regex
          扩展中配置，或点击「从文件导入」选择 ST 正则扩展导出的 JSON 文件（含其他
          角色卡与预设条目）。
        </div>
      ) : props.importableCount === 0 ? (
        <div className="stm-preset-warning" data-stm-field="import-candidates-empty">
          {props.candidates.map((item) =>
            item.kind === "skipped" ? (
              <div key={item.scriptName}>
                跳过「{item.scriptName || "未知"}」：{item.reason}
              </div>
            ) : null,
          )}
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
                  <span className="stm-chip" data-stm-field={`import-source-${index}`}>
                    {SOURCE_LABELS[props.sources[index] ?? "file"]}
                  </span>{" "}
                  {item.rule.name}
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
      {props.target.kind === "existing" ? (
        <div className="stm-setting-hint" data-stm-field="import-target-list">
          导入到：{props.targetListName}
        </div>
      ) : (
        <div className="stm-setting-row">
          <div className="stm-setting-label">
            <div className="stm-setting-name">新建列表名称</div>
          </div>
          <input
            type="text"
            className="stm-input"
            data-stm-field="import-target-name"
            value={props.target.name}
            onChange={(event) => props.onTargetChange({ kind: "new", name: event.target.value })}
          />
        </div>
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
