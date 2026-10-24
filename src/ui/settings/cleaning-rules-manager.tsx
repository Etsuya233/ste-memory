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
import { SettingsActionMenu } from "./settings-action-menu.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import type { FillSourceMessage } from "../../features/fill-tasks/fill-task.ts";
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
} from "../../features/cleaning/cleaning-rule-lists.ts";
import {
  convertStRegexScripts,
  type StRegexImportItem,
} from "../../features/cleaning/st-regex-import.ts";
import type {
  StRegexEntry,
  StRegexEntrySource,
} from "../../infrastructure/sillytavern/chat-adapter.ts";
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
import { copyText, createUiId, reportError, reportSuccess } from "../shell/ui-helpers.tsx";

const MODE_LABELS: Record<CleaningRule["mode"], string> = {
  keep: "保留",
  discard: "去掉",
  replace: "替换",
};

export function CleaningRulesManager(props: {
  readonly onBack?: () => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
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
  const [testSnapshot, setTestSnapshot] = useState<{
    readonly rules: readonly CleaningRule[];
    readonly draftOverrides: ReadonlyMap<string, CleaningRuleDraft>;
  } | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [listForm, setListForm] = useState<{
    id?: string;
    name: string;
    initialName: string;
  } | null>(null);
  const listFormId = useId();
  const page = listForm
    ? listForm.id
      ? `edit:list:${listForm.id}`
      : "new:list"
    : importOpen
      ? "import"
      : editingRuleId
        ? pendingRuleId
          ? "new:rule"
          : `edit:rule:${editingRuleId}`
        : detailOpen
          ? `detail:${editListId}`
          : "list";
  const { screenRef, rememberScroll } = useSettingsPageNavigation(page);
  const formId = useId();
  const chrome = props.onBack !== undefined;
  const initialRuleDraft = useRef("");
  const dirty =
    (ruleDraft !== undefined && JSON.stringify(ruleDraft) !== initialRuleDraft.current) ||
    (listForm !== null && listForm.name !== listForm.initialName);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    props.onEditingChange?.(chrome);
    return () => props.onEditingChange?.(false);
  }, [chrome, props.onEditingChange]);
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !dirtyRef.current || window.confirm("规则有未保存的修改，放弃修改并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);
  function startRuleDraft(value: CleaningRuleDraft) {
    initialRuleDraft.current = JSON.stringify(value);
    setRuleDraft(value);
  }
  function tryCancelEdit() {
    if (!dirty || window.confirm("规则有未保存的修改，放弃修改并返回吗？")) cancelEdit();
  }
  function openList(id: string) {
    rememberScroll();
    selectEditList(id);
    setDetailOpen(true);
  }
  function back() {
    if (listForm) {
      if (!dirty || window.confirm("列表名称尚未保存，放弃并返回吗？")) {
        rememberScroll();
        setListForm(null);
      }
    } else if (editingRuleId) tryCancelEdit();
    else if (importOpen) {
      rememberScroll();
      setImportOpen(false);
    } else if (detailOpen) {
      rememberScroll();
      setDetailOpen(false);
    } else props.onBack?.();
  }

  function apply(
    mutate: (current: readonly CleaningRuleList[]) => readonly CleaningRuleList[],
  ): void {
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
        editingRuleId !== undefined && ruleDraft !== undefined
          ? new Map([[editingRuleId, ruleDraft]])
          : new Map(),
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
    const messages = testForm === "text" ? [{ name: "", content: testText }] : testMessages;
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
    rememberScroll();
    setListForm({ name: "我的清洗列表", initialName: "我的清洗列表" });
  }
  function renameList(): void {
    if (!editList) return;
    rememberScroll();
    setListForm({ id: editList.id, name: editList.name, initialName: editList.name });
  }
  function saveListForm() {
    if (!listForm?.name.trim()) return;
    const id = listForm.id ?? createUiId();
    try {
      apply((current) =>
        listForm.id
          ? renameCleaningRuleList(current, id, listForm.name.trim())
          : createCleaningRuleList(current, id, listForm.name.trim()),
      );
      rememberScroll();
      setEditListId(id);
      setDetailOpen(true);
      setImportTarget({ kind: "existing", listId: id });
      setListForm(null);
    } catch (error) {
      reportError(error);
    }
  }

  function deleteList(): void {
    if (!editList) return;
    if (!window.confirm(`删除清洗列表「${editList.name}」？引用它的对话将不再清洗。`)) return;
    const deletedId = editList.id;
    rememberScroll();
    setDetailOpen(false);
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
    rememberScroll();
    startRuleDraft({
      name: "新规则",
      mode: "discard",
      // 新建默认标签类型（ADR 0014）：不懂正则的用户第一眼就是简单路径
      type: "tag",
      pattern: "",
      flags: "g",
      pre: "",
      post: "",
      replacement: "",
      enabled: true,
    });
    setRuleError(undefined);
  }

  function beginEdit(rule: CleaningRule): void {
    setEditingRuleId(rule.id);
    rememberScroll();
    startRuleDraft(ruleDraftFromRule(rule));
    setRuleError(undefined);
  }

  function cancelEdit(): void {
    rememberScroll();
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
    const rule = {
      ...draftToRule(ruleDraft, editingRuleId),
      name: ruleDraft.name.trim() || "未命名规则",
    };
    if (pendingRuleId === editingRuleId) {
      // 新建路径：校验通过才落库（+ 添加规则 = 编辑草稿，取消不产生空规则）
      apply((current) => addCleaningRule(current, editList.id, rule));
    } else {
      // 补丁带 id 无影响：updateCleaningRule 按 ruleId 定位后 spread，id 不变
      apply((current) => updateCleaningRule(current, editList.id, editingRuleId, rule));
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
    rememberScroll();
    try {
      const entries = props.readStRegexEntries();
      const candidates = convertStRegexScripts(
        entries.map((entry) => entry.script),
        createUiId,
      );
      openImportDialog(
        candidates,
        entries.map((entry) => entry.source),
      );
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
      editList
        ? { kind: "existing", listId: editList.id }
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
    rememberScroll();
    setDetailOpen(true);
    setImportOpen(false);
    reportSuccess(`已导入 ${report.created} 条规则`);
  }

  const importableCount = importCandidates.filter((item) => item.kind === "rule").length;
  const selectedCount = importSelected.length;

  return (
    <div
      ref={screenRef}
      className="stm-settings-detail-page"
      data-stm-section="cleaning-rules"
      data-cleaning-screen={
        importOpen ? "import" : editingRuleId ? "rule" : detailOpen ? "detail" : "list"
      }
    >
      {chrome && (
        <PageChrome
          pageKey={page}
          header={
            <PanelBar
              title={
                listForm
                  ? listForm.id
                    ? "重命名清洗列表"
                    : "新建清洗列表"
                  : importOpen
                    ? "导入正则"
                    : editingRuleId
                      ? pendingRuleId
                        ? "新建规则"
                        : "编辑规则"
                      : detailOpen
                        ? editList?.name
                        : "清洗规则"
              }
              subtitle={
                detailOpen && !editingRuleId && !importOpen && !listForm
                  ? `${editList?.rules.length ?? 0} 条规则`
                  : undefined
              }
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label={editingRuleId ? "取消编辑" : "返回"}
                  data-action={
                    listForm
                      ? "cancel-cleaning-list"
                      : editingRuleId
                        ? "cancel-cleaning-rule"
                        : detailOpen || importOpen
                          ? "back-cleaning-lists"
                          : "settings-back"
                  }
                  onClick={back}
                />
              }
              trailing={
                listForm ? (
                  <PanelBarAction
                    icon="fa-check"
                    label="保存列表名称"
                    data-action="save-cleaning-list"
                    type="submit"
                    form={listFormId}
                    disabled={!listForm.name.trim()}
                  />
                ) : importOpen ? (
                  <PanelBarAction
                    icon="fa-check"
                    label="导入所选规则"
                    data-action="confirm-regex-import"
                    disabled={selectedCount === 0}
                    onClick={confirmImport}
                  />
                ) : editingRuleId ? (
                  <>
                    {!pendingRuleId && (
                      <PanelBarAction
                        icon="fa-trash"
                        label="删除规则"
                        data-action="remove-cleaning-rule"
                        danger
                        onClick={() => {
                          if (window.confirm("删除此清洗规则？")) removeRule(editingRuleId);
                        }}
                      />
                    )}
                    <PanelBarAction
                      icon="fa-check"
                      label="保存规则"
                      data-action="save-cleaning-rule"
                      type="submit"
                      form={formId}
                    />
                  </>
                ) : detailOpen ? (
                  <>
                    <PanelBarAction
                      icon="fa-flask"
                      label="测试规则列表"
                      data-action="test-cleaning-list"
                      onClick={openTest}
                    />
                    <SettingsActionMenu
                      actions={[
                        {
                          label: "重命名",
                          dataAction: "rename-cleaning-list",
                          onSelect: renameList,
                        },
                        {
                          label: "导入规则到此列表",
                          dataAction: "import-st-regex",
                          onSelect: openImportFromSt,
                        },
                        {
                          label: "删除列表",
                          dataAction: "delete-cleaning-list",
                          danger: true,
                          onSelect: deleteList,
                        },
                      ]}
                    />
                    <PanelBarAction
                      icon="fa-plus"
                      label="添加规则"
                      data-action="add-cleaning-rule"
                      onClick={addRule}
                    />
                  </>
                ) : (
                  <>
                    <PanelBarAction
                      icon="fa-file-import"
                      label="导入正则"
                      data-action="import-st-regex"
                      onClick={openImportFromSt}
                    />
                    <PanelBarAction
                      icon="fa-plus"
                      label="新建列表"
                      data-action="create-cleaning-list"
                      onClick={createList}
                    />
                  </>
                )
              }
            />
          }
        />
      )}
      {listForm ? (
        <form
          id={listFormId}
          className="stm-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveListForm();
          }}
        >
          <label className="stm-form-row">
            <span className="stm-form-label">列表名称</span>
            <input
              className="stm-input"
              data-stm-field="cleaning-list-name"
              value={listForm.name}
              autoFocus
              required
              onChange={(event) => setListForm({ ...listForm, name: event.target.value })}
            />
          </label>
          {!chrome && (
            <button type="submit" className="stm-button" data-action="save-cleaning-list">
              保存列表名称
            </button>
          )}
        </form>
      ) : importOpen ? (
        <ImportDialog
          compact={chrome}
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
      ) : editingRuleId && ruleDraft ? (
        <>
          <CleaningRuleEditor
            formId={chrome ? formId : undefined}
            draft={ruleDraft}
            error={ruleError}
            onDraftChange={(next) => {
              setRuleDraft(next);
              setRuleError(undefined);
            }}
            onSave={saveEdit}
            onCancel={tryCancelEdit}
          />
          <Disclosure icon="fa-flask" title="测试草稿">
            <button
              type="button"
              className="stm-button"
              data-action="test-cleaning-list"
              onClick={openTest}
            >
              测试当前规则列表
            </button>
          </Disclosure>
        </>
      ) : detailOpen && editList ? (
        <>
          <ul
            className="stm-grouped-list stm-settings-item-list"
            data-stm-field="cleaning-rule-list"
          >
            {editList.rules.map((rule) => (
              <li key={rule.id} className="stm-settings-item-with-toggle">
                <button
                  type="button"
                  className="stm-settings-item-row"
                  data-action="edit-cleaning-rule"
                  onClick={() => beginEdit(rule)}
                >
                  <span className="stm-settings-item-main">
                    <span className="stm-settings-item-title">{rule.name}</span>
                    <span className="stm-settings-item-summary">
                      {MODE_LABELS[rule.mode]} ·{" "}
                      {rule.type === "tag" ? `${rule.pre} … ${rule.post}` : rule.pattern}
                    </span>
                  </span>
                  <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                </button>
                <label className="stm-switch">
                  <input
                    type="checkbox"
                    aria-label={`启用规则 ${rule.name}`}
                    checked={rule.enabled}
                    onChange={(event) =>
                      apply((current) =>
                        updateCleaningRule(current, editList.id, rule.id, {
                          enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                  <span className="stm-switch-track" aria-hidden="true" />
                </label>
              </li>
            ))}
          </ul>
          {editList.rules.length === 0 && <div className="stm-empty">还没有清洗规则</div>}
          <Disclosure icon="fa-arrows-up-down" title="规则顺序">
            <div className="stm-grouped-list">
              {editList.rules.map((rule, index) => (
                <div className="stm-settings-order-row" key={rule.id}>
                  <span>{rule.name}</span>
                  <PanelBarAction
                    icon="fa-arrow-up"
                    label={`上移规则 ${rule.name}`}
                    data-action="move-cleaning-rule-up"
                    disabled={index === 0}
                    onClick={() => moveRule(rule.id, -1)}
                  />
                  <PanelBarAction
                    icon="fa-arrow-down"
                    label={`下移规则 ${rule.name}`}
                    data-action="move-cleaning-rule-down"
                    disabled={index === editList.rules.length - 1}
                    onClick={() => moveRule(rule.id, 1)}
                  />
                </div>
              ))}
            </div>
          </Disclosure>
        </>
      ) : (
        <>
          <label className="stm-form-row">
            <span className="stm-form-label">当前对话</span>
            <select
              className="stm-input"
              data-stm-field="chat-cleaning-list"
              aria-label="当前对话使用的列表"
              value={props.selectedListId ?? ""}
              onChange={(event) => props.onSelectList(event.target.value || undefined)}
            >
              <option value="">未启用清洗</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <ul className="stm-grouped-list stm-settings-item-list">
            {lists.map((list) => (
              <li key={list.id}>
                <button
                  type="button"
                  className="stm-settings-item-row"
                  data-action="open-cleaning-list"
                  data-list-id={list.id}
                  onClick={() => openList(list.id)}
                >
                  <span className="stm-settings-item-main">
                    <span className="stm-settings-item-title">{list.name}</span>
                    <span className="stm-settings-item-summary">
                      {list.rules.length} 条规则
                      {list.id === props.selectedListId ? " · 当前对话使用" : ""}
                    </span>
                  </span>
                  <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {lists.length === 0 && (
            <div className="stm-empty" data-stm-section="cleaning-rules-empty">
              新建清洗规则列表，或从 ST 导入正则。
            </div>
          )}
          {!chrome && (
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="create-cleaning-list"
                onClick={createList}
              >
                新建列表
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
          )}
        </>
      )}
      {importReport !== null && (
        <div className="stm-setting-hint" data-stm-field="import-report">
          已导入 {importReport.created} 条规则
          {importReport.skipped.length ? ` · 跳过 ${importReport.skipped.length} 条` : ""}
        </div>
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

/** 规则编辑表单（草稿非空时渲染；保存校验由父组件执行）。 */
export function CleaningRuleEditor(props: {
  readonly formId?: string;
  readonly draft: CleaningRuleDraft;
  readonly error: string | undefined;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const draft = props.draft;
  return (
    <form
      id={props.formId}
      className="stm-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <div className="stm-setting-row">
        <label className="stm-settings-field">
          <span className="stm-form-label">规则名称</span>
          <input
            type="text"
            className="stm-input"
            data-stm-field="cleaning-rule-name"
            aria-label="规则名称"
            value={draft.name}
            placeholder="规则名称"
            onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="stm-settings-field">
          <span className="stm-form-label">处理方式</span>
          <select
            className="stm-input"
            data-stm-field="cleaning-rule-mode"
            aria-label="处理方式"
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
        </label>
        <label className="stm-settings-field">
          <span className="stm-form-label">匹配方式</span>
          <select
            className="stm-input"
            data-stm-field="cleaning-rule-type"
            aria-label="匹配方式"
            value={draft.type}
            title="标签 = 填一对普通文本定界符；正则 = 填正则表达式"
            onChange={(event) =>
              props.onDraftChange({ ...draft, type: event.target.value as CleaningRule["type"] })
            }
          >
            <option value="tag">标签</option>
            <option value="regex">正则</option>
          </select>
        </label>
      </div>
      {draft.type === "tag" ? (
        <div className="stm-setting-row">
          <label className="stm-settings-field">
            <span className="stm-form-label">开始标签</span>
            <input
              type="text"
              className="stm-input"
              data-stm-field="cleaning-rule-pre"
              aria-label="开始标签"
              value={draft.pre}
              placeholder="开始标签，如 【内心】"
              onChange={(event) => props.onDraftChange({ ...draft, pre: event.target.value })}
            />
          </label>
          <label className="stm-settings-field">
            <span className="stm-form-label">结束标签</span>
            <input
              type="text"
              className="stm-input"
              data-stm-field="cleaning-rule-post"
              aria-label="结束标签"
              value={draft.post}
              placeholder="结束标签，如 【/内心】"
              onChange={(event) => props.onDraftChange({ ...draft, post: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="stm-setting-row">
          <label className="stm-settings-field">
            <span className="stm-form-label">正则表达式</span>
            <input
              type="text"
              className="stm-input stm-mono"
              data-stm-field="cleaning-rule-pattern"
              aria-label="正则表达式"
              value={draft.pattern}
              placeholder="正则表达式"
              onChange={(event) => props.onDraftChange({ ...draft, pattern: event.target.value })}
            />
          </label>
          <label className="stm-settings-field">
            <span className="stm-form-label">正则标志</span>
            <input
              type="text"
              className="stm-input stm-mono"
              data-stm-field="cleaning-rule-flags"
              aria-label="正则标志"
              value={draft.flags}
              placeholder="flags（g/i/m/s/u/y）"
              onChange={(event) => props.onDraftChange({ ...draft, flags: event.target.value })}
            />
          </label>
        </div>
      )}
      {draft.mode === "replace" && (
        <label className="stm-settings-field">
          <span className="stm-form-label">替换内容</span>
          <input
            type="text"
            className="stm-input stm-mono"
            data-stm-field="cleaning-rule-replacement"
            aria-label="替换内容"
            value={draft.replacement}
            placeholder="替换串（支持 $1 / $<name>）"
            onChange={(event) => props.onDraftChange({ ...draft, replacement: event.target.value })}
          />
        </label>
      )}
      {props.error !== undefined && (
        <div className="stm-preset-warning" data-stm-field="cleaning-rule-error">
          {props.error}
        </div>
      )}
      {!props.formId && (
        <div className="stm-setting-actions">
          <button type="submit" className="stm-button" data-action="save-cleaning-rule">
            保存
          </button>
          <button
            type="button"
            className="stm-button"
            data-action="cancel-cleaning-rule"
            onClick={props.onCancel}
          >
            取消
          </button>
        </div>
      )}
    </form>
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
    <div
      className="stm-modal-overlay"
      data-stm-section="cleaning-test-dialog"
      onClick={props.onClose}
    >
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
              aria-label="测试消息内容"
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
                      onChange={(event) =>
                        props.onMessageChange(index, { name: event.target.value })
                      }
                    />
                  </div>
                  <textarea
                    className="stm-input stm-mono stm-modal-textarea"
                    data-stm-field={`cleaning-test-message-content-${index}`}
                    value={message.content}
                    placeholder="消息内容（仅内容参与清洗）"
                    onChange={(event) =>
                      props.onMessageChange(index, { content: event.target.value })
                    }
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
                    <pre className="stm-mono stm-modal-text">
                      {renderCleaningText(message.input)}
                    </pre>
                    <div className="stm-setting-hint">步骤</div>
                    <ol data-stm-field={`cleaning-test-steps-${index}`}>
                      {message.steps.map((step, stepIndex) => (
                        <li key={step.ruleId} data-stm-field={`cleaning-test-step-${stepIndex}`}>
                          <span className="stm-mono">
                            {step.ruleName} · {MODE_LABELS[step.mode]}
                          </span>
                          {step.fromDraft && <span className="stm-chip">草稿</span>}
                          {step.active ? (
                            <pre className="stm-mono stm-modal-text">
                              {renderCleaningText(step.output)}
                            </pre>
                          ) : (
                            <span className="stm-setting-hint">跳过（已停用）</span>
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="stm-setting-hint">最终结果</div>
                    <pre className="stm-mono stm-modal-text">
                      {renderCleaningText(message.output)}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="stm-modal-footer">
          <button
            type="button"
            className="stm-button"
            data-action="run-cleaning-test"
            onClick={props.onRun}
          >
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
          <button
            type="button"
            className="stm-button"
            data-action="close-cleaning-test"
            onClick={props.onClose}
          >
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
  readonly compact?: boolean;
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
              <label
                key={index}
                className="stm-preset-fragment"
                data-stm-field={`import-candidate-${index}`}
              >
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
            aria-label="新建列表名称"
            value={props.target.name}
            onChange={(event) => props.onTargetChange({ kind: "new", name: event.target.value })}
          />
        </div>
      )}
      {!props.compact && (
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
          <button
            type="button"
            className="stm-button"
            data-action="cancel-regex-import"
            onClick={props.onCancel}
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}
