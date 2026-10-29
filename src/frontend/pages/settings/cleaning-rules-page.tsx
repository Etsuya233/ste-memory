import { useEffect, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  applyCleaningRule,
  validateCleaningRule,
  type CleaningRule,
  type CleaningTagPair,
} from "../../../features/cleaning/cleaning-rules.ts";
import type { FillSourceMessage } from "../../../features/fill-tasks/fill-task.ts";
import { draftToRule } from "../../models/settings/cleaning-rules-manager-model.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import { Card, CardContent } from "../../../ui/primitives/card.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../../ui/primitives/item.tsx";
import { PageContent, PageHeader } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { ConfirmAction } from "../../components/confirmation.tsx";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistCleaningRule, deleteCleaningRule } from "./cleaning-settings-model.ts";

export interface CleaningServices {
  readSelection: () => string | undefined;
  writeSelection: (ruleId: string | undefined) => void;
  readRecentMessages: (count: number) => readonly FillSourceMessage[];
}

export function CleaningRulesPage({
  services,
  cleaning,
  contextKey,
  controls,
  onBack,
  registerLeaveGuard,
}: SettingsSubpageProps & { cleaning: CleaningServices; contextKey: string | null }) {
  const [rules, setRules] = useState(() => services.settings.read().cleaningRules);
  const [selection, setSelection] = useState(cleaning.readSelection);
  const [editor, setEditor] = useState<{
    rule: CleaningRule;
    original: CleaningRule | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSelection(cleaning.readSelection()), [cleaning, contextKey]);
  if (editor)
    return (
      <CleaningRuleEditor
        services={services}
        controls={controls}
        cleaning={cleaning}
        contextKey={contextKey}
        registerLeaveGuard={registerLeaveGuard}
        original={editor.original}
        rule={editor.rule}
        onBack={() => setEditor(null)}
        onSaved={(message) => {
          setRules(services.settings.read().cleaningRules);
          setSelection(cleaning.readSelection());
          setNotice(message);
          setEditor(null);
        }}
      />
    );
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="清洗规则"
        subtitle="全局规则 · 对话独立选择"
        {...controls}
        onBack={onBack}
      />
      <PageContent className="ste:flex ste:flex-col ste:gap-4">
        {(notice || error) && (
          <StatusNotice variant={error ? "destructive" : "default"}>{error ?? notice}</StatusNotice>
        )}
        <PageSection title="当前对话规则">
          <Field>
            <FieldLabel htmlFor="cleaning-selection">当前对话使用的规则</FieldLabel>
            <NativeSelect
              id="cleaning-selection"
              value={selection ?? ""}
              disabled={!contextKey}
              onChange={(event) => {
                try {
                  cleaning.writeSelection(event.target.value || undefined);
                  setSelection(cleaning.readSelection());
                  setError(null);
                  setNotice("当前对话的规则选择已保存。");
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            >
              <option value="">不使用清洗规则</option>
              {selection && !rules.some((rule) => rule.id === selection) && (
                <option value={selection}>所选规则已不存在</option>
              )}
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                  {rule.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              {contextKey
                ? "仅清洗填表输入中的 AI 输出；用户消息、系统消息和初始化文本保持原文。"
                : "请先打开已绑定记忆空间的对话，再选择规则。"}
            </FieldDescription>
          </Field>
        </PageSection>
        <PageSection
          title="规则"
          action={
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">{rules.length} 条</span>
              <Button
                size="sm"
                data-action="create-cleaning-rule"
                onClick={() => {
                  setNotice(null);
                  setError(null);
                  setEditor({
                    original: null,
                    rule: {
                      id: crypto.randomUUID(),
                      name: "",
                      enabled: true,
                      keepTags: [],
                      excludeTags: [],
                    },
                  });
                }}
              >
                <Plus />
                新建
              </Button>
            </div>
          }
          bodyClassName={rules.length ? "ste:p-0" : undefined}
        >
          {rules.length ? (
            <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
              {rules.map((rule) => (
                <div key={rule.id} role="listitem">
                  <Item
                    render={<button type="button" />}
                    className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                    data-action="edit-cleaning-rule"
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setEditor({ rule, original: rule });
                    }}
                  >
                    <ItemContent>
                      <ItemTitle>{rule.name}</ItemTitle>
                      <ItemDescription className="ste:line-clamp-1">
                        {rule.enabled ? "启用" : "停用"} · 排除 {rule.excludeTags.length} 对 · 保留{" "}
                        {rule.keepTags.length} 对
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </ItemGroup>
          ) : (
            <PageEmpty
              title="还没有清洗规则"
              description="创建规则，排除思考标签或保留指定正文。"
            />
          )}
        </PageSection>
      </PageContent>
    </div>
  );
}

function CleaningRuleEditor({
  services,
  cleaning,
  contextKey,
  controls,
  onBack,
  registerLeaveGuard,
  rule,
  original,
  onSaved,
}: SettingsSubpageProps & {
  cleaning: CleaningServices;
  contextKey: string | null;
  rule: CleaningRule;
  original: CleaningRule | null;
  onSaved: (notice: string) => void;
}) {
  const [draft, setDraft] = useState(rule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<readonly FillSourceMessage[] | null>(null);
  const [result, setResult] = useState<
    readonly { name: string; input: string; output: string }[] | null
  >(null);
  const [testError, setTestError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);
  useEffect(() => {
    setMessages(null);
    setResult(null);
    setTestError(null);
  }, [contextKey]);
  function change(next: CleaningRule) {
    setDraft(next);
    setResult(null);
    setTestError(null);
  }
  async function save(remove = false) {
    setBusy(true);
    setError(null);
    try {
      const outcome = remove
        ? await deleteCleaningRule(services, original!)
        : await persistCleaningRule(services, draft, original);
      if (outcome.saved) {
        let warning = outcome.error;
        if (remove && cleaning.readSelection() === rule.id) {
          try {
            cleaning.writeSelection(undefined);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            warning = warning ? `${warning}；${message}` : message;
          }
        }
        onSaved(
          warning
            ? `规则已${remove ? "删除" : "保存"}，后续刷新失败：${warning}`
            : `规则已${remove ? "删除" : "保存"}。`,
        );
      } else {
        throw new Error(outcome.error ?? "清洗规则未保存");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (remove) throw cause;
    } finally {
      setBusy(false);
    }
  }
  function runTest() {
    const validation = validateCleaningRule(draft);
    if (validation) {
      setTestError(validation);
      return;
    }
    setTestError(null);
    const normalized = draftToRule(draft, draft.id);
    setResult(
      messages
        ? messages.map((message) => ({
            name: `${message.floor} · ${message.name}${message.options?.needCleaning ? " · AI 清洗" : " · 保持原文"}`,
            input: message.content,
            output: message.options?.needCleaning
              ? applyCleaningRule(message.content, normalized)
              : message.content,
          }))
        : [{ name: "手动输入", input: text, output: applyCleaningRule(text, normalized) }],
    );
  }
  return (
    <SettingsEditor
      title={original ? "编辑清洗规则" : "新建清洗规则"}
      scope="settings-cleaning-editor"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(rule)}
      onSave={() => void save()}
      error={error}
    >
      <PageSection title="规则">
        <div className="ste:flex ste:flex-col ste:gap-5">
          <Field>
            <FieldLabel htmlFor="cleaning-name">规则名称</FieldLabel>
            <Input
              id="cleaning-name"
              value={draft.name}
              maxLength={120}
              required
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </Field>
          <SwitchField
            label="启用此规则"
            checked={draft.enabled}
            onCheckedChange={(enabled) => change({ ...draft, enabled })}
            description="停用后保留规则配置，填表输入使用原文。"
          />
          <FieldDescription>
            先删除排除标签及其内容，再从剩余文本提取保留标签内的正文。同组标签按 OR
            匹配，区分大小写；保留标签为空时使用排除后的全文。
          </FieldDescription>
        </div>
      </PageSection>
      <TagPairs
        label="排除标签"
        tags={draft.excludeTags}
        onChange={(excludeTags) => change({ ...draft, excludeTags })}
      />
      <TagPairs
        label="保留标签"
        tags={draft.keepTags}
        onChange={(keepTags) => change({ ...draft, keepTags })}
      />
      <PageSection
        title="测试"
        action={
          <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!contextKey}
              onClick={() => {
                try {
                  const recent = cleaning.readRecentMessages(20);
                  setMessages(recent);
                  setResult(null);
                  setTestError(recent.length ? null : "当前对话没有消息。");
                } catch (cause) {
                  setTestError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            >
              载入当前对话
            </Button>
            <Button type="button" size="sm" onClick={runTest}>
              运行测试
            </Button>
          </div>
        }
      >
        <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
          <Field>
            <FieldLabel htmlFor="cleaning-test-input">测试文本</FieldLabel>
            <Textarea
              id="cleaning-test-input"
              value={text}
              placeholder="输入包含标签的 AI 输出"
              onChange={(event) => {
                setText(event.target.value);
                setMessages(null);
                setResult(null);
              }}
            />
            <FieldDescription>测试在本地执行，不保存规则或修改对话消息。</FieldDescription>
          </Field>
          {messages && (
            <p className="ste:text-xs ste:text-muted-foreground">
              已载入最近 {messages.length} 条消息；其中{" "}
              {messages.filter((message) => message.options?.needCleaning).length} 条 AI
              输出应用规则。
            </p>
          )}
          {testError && <StatusNotice variant="destructive">{testError}</StatusNotice>}
          {result && (
            <div role="status" className="ste:flex ste:flex-col ste:gap-3">
              {result.map((item, index) => (
                <div
                  key={index}
                  className="ste:flex ste:flex-col ste:gap-2 ste:rounded-xl ste:bg-muted ste:p-3"
                >
                  <p className="ste:text-xs ste:font-semibold">{item.name}</p>
                  <details>
                    <summary className="ste:cursor-pointer ste:text-xs">查看原文</summary>
                    <pre className="ste:mt-2 ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                      {item.input}
                    </pre>
                  </details>
                  <p className="ste:whitespace-pre-wrap ste:break-words ste:text-sm">
                    {item.output || "（输出为空）"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </PageSection>
      {original && (
        <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>
          <Trash2 />
          删除规则
        </Button>
      )}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除规则「${rule.name}」？`}
        description="使用这份规则的对话将不再执行清洗，规则配置无法恢复。"
        destructive
        confirmLabel="确认删除"
        onConfirm={() => save(true)}
      />
    </SettingsEditor>
  );
}

function TagPairs({
  label,
  tags,
  onChange,
}: {
  label: string;
  tags: readonly CleaningTagPair[];
  onChange: (tags: readonly CleaningTagPair[]) => void;
}) {
  return (
    <PageSection
      title={label}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...tags, { pre: "", post: "" }])}
        >
          <Plus />
          添加{label}
        </Button>
      }
    >
      {tags.length ? (
        <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
          {tags.map((tag, index) => (
            <Card
              key={index}
              size="sm"
              className="ste:rounded-xl ste:shadow-none ste:ring-1 ste:ring-border"
            >
              <CardContent className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
                <Field>
                  <FieldLabel htmlFor={`${label}-${index}-pre`}>
                    {label} {index + 1} 开始
                  </FieldLabel>
                  <Input
                    id={`${label}-${index}-pre`}
                    value={tag.pre}
                    required
                    onChange={(event) =>
                      onChange(
                        tags.map((item, i) =>
                          i === index ? { ...item, pre: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${label}-${index}-post`}>
                    {label} {index + 1} 结束
                  </FieldLabel>
                  <Input
                    id={`${label}-${index}-post`}
                    value={tag.post}
                    required
                    onChange={(event) =>
                      onChange(
                        tags.map((item, i) =>
                          i === index ? { ...item, post: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  className="ste:self-end"
                  onClick={() => onChange(tags.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                  移除{label} {index + 1}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <p className="ste:text-sm ste:text-muted-foreground">尚未添加{label}。</p>
      )}
    </PageSection>
  );
}
