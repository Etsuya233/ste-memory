import { Dialog } from "../kit/dialog.tsx";
import { Button, Input, Select, Switch, Textarea } from "../kit/controls.tsx";
import { ListGroup, NavigationRow } from "../kit/list.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import type { FillSourceMessage } from "../../features/fill-tasks/fill-task.ts";
import {
  saveCleaningRule,
  removeCleaningRule,
  type CleaningRule,
} from "../../features/cleaning/cleaning-rules.ts";
import {
  draftToRule,
  ruleDraftFromRule,
  runCleaningTest,
  validateRuleDraft,
  type CleaningRuleDraft,
  type CleaningTestMessage,
  type CleaningTestRun,
} from "./cleaning-rules-manager-model.ts";
import { copyText, createUiId, reportSuccess } from "../shell/ui-helpers.tsx";

export function CleaningRulesManager(props: {
  readonly onBack?: () => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  readonly settings: PluginSettings;
  readonly selectedRuleId: string | undefined;
  readonly onSelectRule: (ruleId: string | undefined) => void;
  readonly onChange: (settings: PluginSettings) => void;
  readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
}) {
  const rules = props.settings.cleaningRules;
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<CleaningRuleDraft>();
  const [error, setError] = useState<string>();
  const initialDraft = useRef("");
  const dirty = draft !== undefined && JSON.stringify(draft) !== initialDraft.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const existing = rules.find((rule) => rule.id === editingId);
  const page = editingId ? `edit:${editingId}` : "rules";
  const { screenRef, rememberScroll } = useSettingsPageNavigation(page);
  const formId = useId();
  const chrome = props.onBack !== undefined;
  const [testRule, setTestRule] = useState<CleaningRule>();
  const [testHasDraft, setTestHasDraft] = useState(false);
  const [testForm, setTestForm] = useState<"text" | "messages">("text");
  const [testText, setTestText] = useState("");
  const [testMessages, setTestMessages] = useState<readonly CleaningTestMessage[]>([]);
  const [testResult, setTestResult] = useState<CleaningTestRun>();
  const [testLoadHint, setTestLoadHint] = useState<string | null>(null);

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

  function beginEdit(rule: CleaningRule) {
    rememberScroll();
    setEditingId(rule.id);
    const value = ruleDraftFromRule(rule);
    initialDraft.current = JSON.stringify(value);
    setDraft(value);
    setError(undefined);
  }
  function closeEditor() {
    rememberScroll();
    setEditingId(undefined);
    setDraft(undefined);
    setError(undefined);
  }
  function back() {
    if (editingId) {
      if (!dirty || window.confirm("规则有未保存的修改，放弃修改并返回吗？")) closeEditor();
    } else props.onBack?.();
  }
  function save() {
    const validation = validateRuleDraft(draft!);
    if (validation) {
      setError(validation);
      return;
    }
    props.onChange({
      ...props.settings,
      cleaningRules: saveCleaningRule(rules, draftToRule(draft!, editingId!)),
    });
    closeEditor();
    reportSuccess("规则已保存");
  }
  function remove() {
    if (!window.confirm(`删除清洗规则「${existing!.name}」？引用它的对话将不再清洗。`)) return;
    props.onChange({ ...props.settings, cleaningRules: removeCleaningRule(rules, editingId!) });
    if (props.selectedRuleId === editingId) props.onSelectRule(undefined);
    closeEditor();
  }
  function openTest() {
    setTestRule(draftToRule(draft!, editingId!));
    setTestHasDraft(!existing || dirty);
    setTestText("");
    setTestMessages([]);
    setTestForm("text");
    setTestResult(undefined);
    setTestLoadHint(null);
  }
  function loadTestMessages() {
    const messages = props.readRecentMessages(20);
    if (messages.length === 0) {
      setTestLoadHint("当前对话没有消息");
      return;
    }
    setTestMessages(messages.map(({ name, content }) => ({ name, content })));
    setTestForm("messages");
    setTestResult(undefined);
    setTestLoadHint(null);
  }
  function copyResult() {
    if (testResult?.kind !== "ok") return;
    copyText(
      testResult.messages
        .map((message) => (message.name ? `${message.name}：${message.output}` : message.output))
        .join("\n"),
    );
  }

  return (
    <div
      ref={screenRef}
      className="stm-settings-detail-page"
      data-stm-section="cleaning-rules"
      data-cleaning-screen={editingId ? "rule" : "rules"}
    >
      {chrome && (
        <PageChrome
          pageKey={page}
          header={
            <PanelBar
              title={editingId ? (existing ? "编辑清洗规则" : "新建清洗规则") : "清洗规则"}
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label={editingId ? "取消编辑" : "返回"}
                  onClick={back}
                  data-action={editingId ? "cancel-cleaning-rule" : "settings-back"}
                />
              }
              trailing={
                editingId ? (
                  <>
                    <PanelBarAction
                      icon="fa-flask"
                      label="测试规则"
                      data-action="test-cleaning-rule"
                      onClick={openTest}
                    />
                    <PanelBarAction
                      icon="fa-check"
                      label="保存规则"
                      data-action="save-cleaning-rule"
                      type="submit"
                      form={formId}
                    />
                  </>
                ) : (
                  <PanelBarAction
                    icon="fa-plus"
                    label="新建规则"
                    data-action="create-cleaning-rule"
                    onClick={() =>
                      beginEdit({
                        id: createUiId(),
                        name: "新规则",
                        enabled: true,
                        excludeTags: [],
                        keepTags: [],
                      })
                    }
                  />
                )
              }
            />
          }
        />
      )}
      {draft ? (
        <>
          <CleaningRuleEditor
            formId={chrome ? formId : undefined}
            draft={draft}
            error={error}
            onDraftChange={(value) => {
              setDraft(value);
              setError(undefined);
            }}
            onSave={save}
            onCancel={back}
          />
          <div className="stm-setting-actions stm-cleaning-actions">
            {!chrome && (
              <Button type="button" data-action="test-cleaning-rule" onClick={openTest}>
                测试规则
              </Button>
            )}
            {existing && (
              <Button
                type="button"
                variant="danger"
                data-action="remove-cleaning-rule"
                onClick={remove}
              >
                删除规则
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <label className="stm-form-row stm-cleaning-picker">
            <span className="stm-form-label">当前对话</span>
            <Select
              data-stm-field="chat-cleaning-rule"
              aria-label="当前对话使用的规则"
              value={props.selectedRuleId ?? ""}
              onChange={(event) => props.onSelectRule(event.target.value || undefined)}
            >
              <option value="">未启用清洗</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))}
            </Select>
          </label>
          <ListGroup as="ul" className="stm-settings-item-list">
            {rules.map((rule) => (
              <li key={rule.id} className="stm-settings-item-with-toggle">
                <NavigationRow
                  title={rule.name}
                  data-action="edit-cleaning-rule"
                  data-rule-id={rule.id}
                  onClick={() => beginEdit(rule)}
                  description={
                    <>
                      排除 {rule.excludeTags.length} 个标签 · 保留 {rule.keepTags.length} 个标签
                      {rule.id === props.selectedRuleId ? " · 当前对话使用" : ""}
                    </>
                  }
                />
                <Switch
                  aria-label={`启用规则 ${rule.name}`}
                  checked={rule.enabled}
                  onChange={(event) =>
                    props.onChange({
                      ...props.settings,
                      cleaningRules: saveCleaningRule(rules, {
                        ...rule,
                        enabled: event.target.checked,
                      }),
                    })
                  }
                />
              </li>
            ))}
          </ListGroup>
          {rules.length === 0 && (
            <div className="stm-empty" data-stm-section="cleaning-rules-empty">
              新建清洗规则，配置排除和保留标签。
            </div>
          )}
          {!chrome && (
            <Button
              type="button"
              data-action="create-cleaning-rule"
              onClick={() =>
                beginEdit({
                  id: createUiId(),
                  name: "新规则",
                  enabled: true,
                  excludeTags: [],
                  keepTags: [],
                })
              }
            >
              新建规则
            </Button>
          )}
        </>
      )}
      {testRule && (
        <CleaningTestDialog
          form={testForm}
          text={testText}
          messages={testMessages}
          result={testResult}
          hasDraftOverrides={testHasDraft}
          loadHint={testLoadHint}
          onTextChange={(text) => {
            setTestText(text);
            setTestResult(undefined);
          }}
          onMessageChange={(index, patch) => {
            setTestMessages((current) =>
              current.map((message, i) => (i === index ? { ...message, ...patch } : message)),
            );
            setTestResult(undefined);
          }}
          onLoadMessages={loadTestMessages}
          onRun={() =>
            setTestResult(
              runCleaningTest(
                testRule,
                testForm === "text" ? [{ name: "", content: testText }] : testMessages,
              ),
            )
          }
          onCopy={copyResult}
          onClose={() => setTestRule(undefined)}
        />
      )}
    </div>
  );
}

/** iOS 分组表单：每个标签对占两行，操作与字段放在同一个 surface 内。 */
export function CleaningRuleEditor(props: {
  readonly formId?: string;
  readonly draft: CleaningRuleDraft;
  readonly error: string | undefined;
  readonly onDraftChange: (draft: CleaningRuleDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  const nameId = useId();
  return (
    <form
      id={props.formId}
      className="stm-cleaning-editor"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <div className="stm-cleaning-intro">
        <div className="stm-cleaning-card stm-cleaning-name-row">
          <label htmlFor={nameId}>规则名称</label>
          <Input
            id={nameId}
            data-stm-field="cleaning-rule-name"
            value={draft.name}
            placeholder="为规则命名"
            autoComplete="off"
            onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
          />
        </div>
        <p className="stm-cleaning-footnote">先排除后保留，每组命中任一标签即可。</p>
      </div>
      {(["excludeTags", "keepTags"] as const).map((key) => {
        const label = key === "keepTags" ? "保留" : "排除";
        return (
          <fieldset key={key} className="stm-cleaning-section" data-stm-field={`cleaning-${key}`}>
            <legend>{label}标签</legend>
            <div className="stm-cleaning-card">
              {draft[key].map((tag, index) => (
                <div key={index} className="stm-cleaning-pair">
                  <Button
                    type="button"
                    className="stm-cleaning-remove"
                    aria-label={`删除${label}标签 ${index + 1}`}
                    title={`删除${label}标签 ${index + 1}`}
                    onClick={() =>
                      props.onDraftChange({
                        ...draft,
                        [key]: draft[key].filter((_, i) => i !== index),
                      })
                    }
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="10" cy="10" r="9" fill="currentColor" />
                      <path d="M6 10h8" stroke="white" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </Button>
                  <div className="stm-cleaning-pair-fields">
                    {(["pre", "post"] as const).map((boundary) => (
                      <label key={boundary} className="stm-cleaning-tag-row">
                        <span>{boundary === "pre" ? "开始" : "结束"}</span>
                        <Input
                          aria-label={`${label}${boundary === "pre" ? "开始" : "结束"}标签 ${index + 1}`}
                          value={tag[boundary]}
                          placeholder={boundary === "pre" ? "<正文>" : "</正文>"}
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          onChange={(event) =>
                            props.onDraftChange({
                              ...draft,
                              [key]: draft[key].map((item, i) =>
                                i === index ? { ...item, [boundary]: event.target.value } : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <Button
                type="button"
                className="stm-cleaning-add"
                data-action={`add-${key}`}
                onClick={() =>
                  props.onDraftChange({ ...draft, [key]: [...draft[key], { pre: "", post: "" }] })
                }
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M6 10h8M10 6v8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                添加{label}标签
              </Button>
            </div>
            <p className="stm-cleaning-footnote">
              {key === "keepTags"
                ? "留空时保留其余全文；已配置但未命中时输出空文本。"
                : "删除标签及其中内容，保留其余文本。"}
            </p>
          </fieldset>
        );
      })}
      <details className="stm-cleaning-help">
        <summary>匹配说明</summary>
        <p>
          标签按普通文本区分大小写匹配，支持跨行。缺少结束标签时不匹配，不支持同名嵌套。多个保留片段按原文顺序用换行连接。
        </p>
      </details>
      {props.error !== undefined && (
        <div className="stm-preset-warning" role="alert" data-stm-field="cleaning-rule-error">
          {props.error}
        </div>
      )}
      {!props.formId && (
        <div className="stm-setting-actions">
          <Button type="submit" variant="primary" data-action="save-cleaning-rule">
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

/** 清洗测试弹窗（ticket 27）：对当前清洗规则的预览工具。
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
            {!props.result.active && (
              <div className="stm-preset-warning" data-stm-field="cleaning-test-no-active-rule">
                当前规则已停用，结果为原文
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
