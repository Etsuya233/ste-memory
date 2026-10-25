import { Dialog } from "../kit/dialog.tsx";
import { FormField, Button, Input, Select, Switch, Textarea } from "../kit/controls.tsx";
import { ListGroup, NavigationRow } from "../kit/list.tsx";
/** 标签清洗规则列表、草稿编辑与测试。 */
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
  draftToRule,
  ruleDraftFromRule,
  runCleaningTest,
  validateRuleDraft,
  type CleaningRuleDraft,
  type CleaningTestMessage,
  type CleaningTestRun,
} from "./cleaning-rules-manager-model.ts";
import { copyText, createUiId, reportError, reportSuccess } from "../shell/ui-helpers.tsx";

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
    else if (detailOpen) {
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
      keepTags: [],
      excludeTags: [],
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
      name: ruleDraft.name.trim(),
    };
    if (pendingRuleId === editingRuleId) {
      // 新建路径：校验通过才落库（+ 添加规则 = 编辑草稿，取消不产生空规则）
      apply((current) => addCleaningRule(current, editList.id, rule));
    } else {
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

  return (
    <div
      ref={screenRef}
      className="stm-settings-detail-page"
      data-stm-section="cleaning-rules"
      data-cleaning-screen={editingRuleId ? "rule" : detailOpen ? "detail" : "list"}
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
                  : editingRuleId
                    ? pendingRuleId
                      ? "新建规则"
                      : "编辑规则"
                    : detailOpen
                      ? editList?.name
                      : "清洗规则"
              }
              subtitle={
                detailOpen && !editingRuleId && !listForm
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
                        : detailOpen
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
          <FormField className="stm-form-row" label={<>列表名称</>}>
            {(field) => (
              <Input
                {...field}

                data-stm-field="cleaning-list-name"
                value={listForm.name}
                autoFocus
                required
                onChange={(event) => setListForm({ ...listForm, name: event.target.value })}
              />
            )}
          </FormField>
          {!chrome && (
            <Button type="submit" data-action="save-cleaning-list">
              保存列表名称
            </Button>
          )}
        </form>
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
            <Button
              type="button"

              data-action="test-cleaning-list"
              onClick={openTest}
            >
              测试当前规则列表
            </Button>
          </Disclosure>
        </>
      ) : detailOpen && editList ? (
        <>
          <ListGroup as="ul" className="stm-settings-item-list" data-stm-field="cleaning-rule-list">
            {editList.rules.map((rule) => (
              <li key={rule.id} className="stm-settings-item-with-toggle">
                <NavigationRow
                  data-action="edit-cleaning-rule"
                  onClick={() => beginEdit(rule)}
                  title={rule.name}
                  description=<>
                    保留 {rule.keepTags.length} 个标签 · 排除 {rule.excludeTags.length} 个标签
                  </>
                />
                <Switch
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
              </li>
            ))}
          </ListGroup>
          {editList.rules.length === 0 && <div className="stm-empty">还没有清洗规则</div>}
          <Disclosure icon="fa-arrows-up-down" title="规则顺序">
            <ListGroup>
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
            </ListGroup>
          </Disclosure>
        </>
      ) : (
        <>
          <label className="stm-form-row">
            <span className="stm-form-label">当前对话</span>
            <Select
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
            </Select>
          </label>
          <ListGroup as="ul" className="stm-settings-item-list">
            {lists.map((list) => (
              <li key={list.id}>
                <NavigationRow
                  data-action="open-cleaning-list"
                  data-list-id={list.id}
                  onClick={() => openList(list.id)}
                  title={list.name}
                  description=<>
                    {list.rules.length} 条规则
                    {list.id === props.selectedListId ? " · 当前对话使用" : ""}
                  </>
                />
              </li>
            ))}
          </ListGroup>
          {lists.length === 0 && (
            <div className="stm-empty" data-stm-section="cleaning-rules-empty">
              新建清洗规则列表，配置保留和排除标签。
            </div>
          )}
          {!chrome && (
            <div className="stm-setting-actions">
              <Button
                type="button"

                data-action="create-cleaning-list"
                onClick={createList}
              >
                新建列表
              </Button>
            </div>
          )}
        </>
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

/** 一条规则同时编辑两组标签，组内 OR，先保留后排除。 */
export function CleaningRuleEditor(props: {
  readonly formId?: string;
  readonly draft: CleaningRuleDraft;
  readonly error: string | undefined;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  return (
    <form
      id={props.formId}
      className="stm-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <FormField label="规则名称">
        {(field) => (
          <Input
            {...field}
            data-stm-field="cleaning-rule-name"
            value={draft.name}
            onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
          />
        )}
      </FormField>
      <p className="stm-setting-hint">
        先保留后排除，每组命中任一标签即可。标签按普通文本区分大小写匹配，不支持同名嵌套。
      </p>
      {(["keepTags", "excludeTags"] as const).map((key) => {
        const label = key === "keepTags" ? "保留" : "排除";
        return (
          <fieldset key={key} className="stm-settings-form" data-stm-field={`cleaning-${key}`}>
            <legend>{label}标签</legend>
            <p className="stm-setting-hint">
              {key === "keepTags"
                ? "留空表示保留全文；有配置但未命中时输出空文本。多个片段按原文顺序用换行连接。"
                : "删除标签及其中内容。缺少结束标签时不匹配。"}
            </p>
            {draft[key].map((tag, index) => (
              <div key={index} className="stm-settings-form">
                <FormField label={`${label}开始标签 ${index + 1}`}>
                  {(field) => (
                    <Input
                      {...field}
                      value={tag.pre}
                      placeholder="<正文>"
                      onChange={(event) =>
                        props.onDraftChange({
                          ...draft,
                          [key]: draft[key].map((item, i) =>
                            i === index ? { ...item, pre: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  )}
                </FormField>
                <FormField label={`${label}结束标签 ${index + 1}`}>
                  {(field) => (
                    <Input
                      {...field}
                      value={tag.post}
                      placeholder="</正文>"
                      onChange={(event) =>
                        props.onDraftChange({
                          ...draft,
                          [key]: draft[key].map((item, i) =>
                            i === index ? { ...item, post: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  )}
                </FormField>
                <Button
                  type="button"
                  aria-label={`删除${label}标签 ${index + 1}`}
                  onClick={() =>
                    props.onDraftChange({
                      ...draft,
                      [key]: draft[key].filter((_, i) => i !== index),
                    })
                  }
                >
                  删除标签
                </Button>
              </div>
            ))}
            <Button
              type="button"
              data-action={`add-${key}`}
              onClick={() =>
                props.onDraftChange({ ...draft, [key]: [...draft[key], { pre: "", post: "" }] })
              }
            >
              添加{label}标签
            </Button>
          </fieldset>
        );
      })}
      {props.error !== undefined && (
        <div className="stm-preset-warning" role="alert" data-stm-field="cleaning-rule-error">
          {props.error}
        </div>
      )}
      {!props.formId && (
        <div className="stm-setting-actions">
          <Button type="submit" data-action="save-cleaning-rule">
            保存
          </Button>
          <Button type="button" data-action="cancel-cleaning-rule" onClick={props.onCancel}>
            取消
          </Button>
        </div>
      )}
    </form>
  );
}

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
    <Dialog
      label="清洗测试"
      onClose={props.onClose}
      data-stm-section="cleaning-test-dialog"
      contentClassName="stm-modal"
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
          <Button
            type="button"

            data-action="load-chat-messages"
            onClick={props.onLoadMessages}
          >
            从当前对话载入
          </Button>
        </div>
        {props.form === "text" ? (
          <Textarea
            className="stm-mono stm-modal-textarea"
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
                  <Input
                    type="text"

                    data-stm-field={`cleaning-test-message-name-${index}`}
                    value={message.name}
                    placeholder="发送者名"
                    onChange={(event) => props.onMessageChange(index, { name: event.target.value })}
                  />
                </div>
                <Textarea
                  className="stm-mono stm-modal-textarea"
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
                  <pre className="stm-mono stm-modal-text">{renderCleaningText(message.input)}</pre>
                  <div className="stm-setting-hint">步骤</div>
                  <ol data-stm-field={`cleaning-test-steps-${index}`}>
                    {message.steps.map((step, stepIndex) => (
                      <li key={step.ruleId} data-stm-field={`cleaning-test-step-${stepIndex}`}>
                        <span className="stm-mono">{step.ruleName}</span>
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
        <Button
          type="button"

          data-action="run-cleaning-test"
          onClick={props.onRun}
        >
          清洗
        </Button>
        <Button
          type="button"

          data-action="copy-cleaning-test"
          disabled={!hasResult || props.result?.kind !== "ok"}
          onClick={props.onCopy}
        >
          复制结果
        </Button>
        <Button
          type="button"

          data-action="close-cleaning-test"
          onClick={props.onClose}
        >
          关闭
        </Button>
      </div>
    </Dialog>
  );
}

/** 空内容统一显示「（空）」（PreviewModal 先例）。 */
function renderCleaningText(content: string): string {
  return content === "" ? "（空）" : content;
}
