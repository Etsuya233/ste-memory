import { Plus, Save } from "lucide-react";
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

  return (
    <section className="cleaning-rules-panel">
      <div className="sidebar-heading">
        <h2>清洗规则</h2>
        <span>{draft.length} 条 · 读取时生效</span>
      </div>
      <div className="cleaning-rules-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => setDraft((current) => [...current, newDraftRule(crypto.randomUUID())])}
        >
          <Plus size={14} /> 添加规则
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!dirty || hasErrors || saving}
          onClick={() => void save()}
        >
          <Save size={14} /> {saving ? "保存中..." : "保存"}
        </button>
      </div>
      {error ? <div className="page-error">{error}</div> : null}
      {saveResult ? <div className="cleaning-save-result">{saveResult}</div> : null}
      {loading && draft.length === 0 ? <p className="empty-list">正在读取...</p> : null}
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
      {draft.length === 0 && !loading ? (
        <p className="empty-list">还没有规则。添加规则后，消息展示与填表输入会在保存时生效。</p>
      ) : null}
      <div className="cleaning-preview">
        <h3>预览（前 {PREVIEW_MESSAGE_LIMIT} 条消息）</h3>
        {rawMessages.length === 0 ? (
          <p className="empty-list">暂无消息可预览</p>
        ) : (
          <ul>
            {rawMessages.map((message, index) => (
              <li key={message.source_id}>
                <span className="cleaning-preview-id">#{message.source_id}</span>
                <span className="cleaning-preview-original">{message.content}</span>
                <span className="cleaning-preview-arrow">→</span>
                <span className="cleaning-preview-cleaned">
                  {preview[index] === message.content
                    ? `${message.content}（无变化）`
                    : preview[index]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
