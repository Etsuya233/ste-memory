import { Eraser, Plus, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  applyCleaningRules,
  createCleaningRule,
  deleteCleaningRule,
  listCleaningRules,
  loadRawMessages,
  reorderCleaningRules,
  updateCleaningRule,
  validateCleaningRule,
  type CleaningRule,
} from "../api/cleaning-rules.ts";
import type { SourceMessage } from "../api/memory-spaces.ts";
import { CleaningRuleRow } from "./CleaningRuleRow.tsx";
import { Badge, Button } from "../ui.tsx";
import "./cleaning-rules.css";

/** 预览使用的原文消息条数（raw=1&limit=N 拉取）。 */
const PREVIEW_MESSAGE_LIMIT = 10;

interface DraftRule extends CleaningRule {
  readonly isNew: boolean;
}

interface CleaningRulesPanelProps {
  readonly spaceId: string;
  /** 保存成功后通知外层刷新消息展示（ChatViewer 需要看到清洗后的内容）。 */
  readonly onSaved: () => void;
}

function newDraftRule(id: string): DraftRule {
  return {
    id,
    memorySpaceId: "",
    position: 0,
    enabled: true,
    name: "新规则",
    mode: "discard",
    pattern: "",
    flags: "g",
    isNew: true,
  };
}

function sameRule(a: CleaningRule, b: CleaningRule): boolean {
  return (
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.mode === b.mode &&
    a.pattern === b.pattern &&
    a.flags === b.flags
  );
}

/** 清洗规则面板（ADR apps/0001）：草稿编辑 + 单保存 + 前 10 条消息实时预览。 */
export function CleaningRulesPanel({ spaceId, onSaved }: CleaningRulesPanelProps) {
  const [draft, setDraft] = useState<DraftRule[]>([]);
  const [original, setOriginal] = useState<CleaningRule[]>([]);
  const [rawMessages, setRawMessages] = useState<SourceMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saveResult, setSaveResult] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setSaveResult(undefined);
    setDraft([]);
    setOriginal([]);
    setRawMessages([]);
    void Promise.all([listCleaningRules(spaceId), loadRawMessages(spaceId, PREVIEW_MESSAGE_LIMIT)])
      .then(([rules, messages]) => {
        if (!active) return;
        setOriginal(rules);
        setDraft(rules.map((rule) => ({ ...rule, isNew: false })));
        setRawMessages(messages);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取清洗规则");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [spaceId]);

  const errors = useMemo(() => draft.map((rule) => validateCleaningRule(rule)), [draft]);
  const hasErrors = errors.some((message) => message !== undefined);

  const dirty = useMemo(() => {
    if (draft.length !== original.length) return true;
    return draft.some((rule) => {
      const saved = original.find((item) => item.id === rule.id);
      return saved === undefined || !sameRule(rule, saved);
    });
  }, [draft, original]);

  /** 预览只应用合法的规则（非法正则跳过，错误已在行内红字提示）。 */
  const previewRules = useMemo(
    () => draft.filter((_, index) => errors[index] === undefined),
    [draft, errors],
  );
  const preview = useMemo(
    () => rawMessages.map((message) => applyCleaningRules(message.content, previewRules)),
    [rawMessages, previewRules],
  );

  function updateRule(index: number, patch: Partial<CleaningRule>) {
    setDraft((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    setSaveResult(undefined);
  }

  function move(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const rule = current[index];
      const targetRule = current[target];
      if (!rule || !targetRule) return current;
      const next = [...current];
      [next[index], next[target]] = [targetRule, rule];
      return next;
    });
  }

  async function save() {
    if (hasErrors || saving) return;
    setSaving(true);
    setError(undefined);
    setSaveResult(undefined);
    try {
      // 先删后建再改最后重排：reorder 要求 id 集合与当前行数一致。
      for (const rule of original) {
        if (!draft.some((item) => item.id === rule.id)) {
          await deleteCleaningRule(spaceId, rule.id);
        }
      }
      const created: CleaningRule[] = [];
      for (const rule of draft.filter((item) => item.isNew)) {
        created.push(
          await createCleaningRule(spaceId, {
            name: rule.name,
            mode: rule.mode,
            pattern: rule.pattern,
            flags: rule.flags,
            enabled: rule.enabled,
          }),
        );
      }
      const createdIds = [...created];
      const finalIds = draft.map((rule) => (rule.isNew ? createdIds.shift()!.id : rule.id));
      for (const rule of draft) {
        if (rule.isNew) continue;
        const saved = original.find((item) => item.id === rule.id);
        if (!saved || sameRule(rule, saved)) continue;
        await updateCleaningRule(spaceId, rule.id, {
          enabled: rule.enabled,
          name: rule.name,
          mode: rule.mode,
          pattern: rule.pattern,
          flags: rule.flags,
        });
      }
      await reorderCleaningRules(spaceId, finalIds);
      const refreshed = await listCleaningRules(spaceId);
      setOriginal(refreshed);
      setDraft(refreshed.map((rule) => ({ ...rule, isNew: false })));
      setSaveResult("已保存");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const appliedCount = preview.filter((text, index) => text !== rawMessages[index]?.content)
    .length;

  return (
    <div className="cleaning-panel">
      <div className="cleaning-rules-column">
        <header className="tool-panel-heading">
          <div>
            <h3>清洗规则</h3>
            <p>按顺序作用于每条原始消息，读取时生效。</p>
          </div>
          <Badge tone={dirty ? "warn" : "neutral"}>{dirty ? "有未保存修改" : "已保存"}</Badge>
        </header>

        <div className="cleaning-rules-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} />}
            disabled={loading}
            onClick={() => setDraft((current) => [...current, newDraftRule(crypto.randomUUID())])}
          >
            添加规则
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Save size={13} />}
            disabled={!dirty || hasErrors || saving}
            loading={saving}
            onClick={() => void save()}
          >
            保存全部
          </Button>
          {saveResult ? <span className="cleaning-save-result">✓ {saveResult}</span> : null}
        </div>

        {error ? <div className="form-error">{error}</div> : null}
        {loading && draft.length === 0 ? (
          <div className="empty-state">
            <Eraser size={26} />
            <p>正在读取规则...</p>
          </div>
        ) : null}
        {!loading && draft.length === 0 ? (
          <div className="empty-state">
            <Eraser size={26} />
            <strong>还没有规则</strong>
            <p>添加规则后，消息展示与填表输入会在保存时生效。</p>
          </div>
        ) : (
          <div className="cleaning-rule-list">
            {draft.map((rule, index) => (
              <CleaningRuleRow
                key={rule.id}
                rule={rule}
                index={index}
                ruleCount={draft.length}
                error={errors[index]}
                onUpdate={updateRule}
                onMove={move}
                onRemove={(removeIndex) =>
                  setDraft((current) => current.filter((_, i) => i !== removeIndex))
                }
              />
            ))}
          </div>
        )}
      </div>

      <div className="cleaning-preview-column">
        <header className="tool-panel-heading">
          <div>
            <h3>实时预览</h3>
            <p>前 {PREVIEW_MESSAGE_LIMIT} 条消息：原样 → 清洗后。</p>
          </div>
          {rawMessages.length > 0 ? (
            <Badge tone={appliedCount > 0 ? "accent" : "neutral"}>
              {appliedCount} 条受影响
            </Badge>
          ) : null}
        </header>
        {rawMessages.length === 0 ? (
          <div className="empty-state">
            <Eraser size={26} />
            <p>暂无消息可预览</p>
          </div>
        ) : (
          <ul className="cleaning-preview">
            {rawMessages.map((message, index) => {
              const cleaned = preview[index];
              const changed = cleaned !== message.content;
              return (
                <li key={message.source_id} className={changed ? "changed" : ""}>
                  <span className="cleaning-preview-id">#{message.source_id}</span>
                  <span className="cleaning-preview-original" title={message.content}>
                    {message.content}
                  </span>
                  <span className="cleaning-preview-arrow">→</span>
                  <span className="cleaning-preview-cleaned" title={cleaned}>
                    {changed ? cleaned : <em className="cleaning-preview-unchanged">（无变化）</em>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
