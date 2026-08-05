import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import {
  CLEANING_RULE_FLAGS,
  type CleaningRule,
  type CleaningRuleMode,
} from "../api/cleaning-rules.ts";

interface CleaningRuleRowProps {
  readonly rule: CleaningRule;
  readonly index: number;
  readonly ruleCount: number;
  readonly error?: string;
  readonly onUpdate: (index: number, patch: Partial<CleaningRule>) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
}

/** 单条清洗规则的编辑行：启用开关、名称、模式、正则、flags 勾选、上移/下移/删除。 */
export function CleaningRuleRow({
  rule,
  index,
  ruleCount,
  error,
  onUpdate,
  onMove,
  onRemove,
}: CleaningRuleRowProps) {
  function toggleFlag(flag: string, checked: boolean) {
    const flags = checked
      ? [...rule.flags].includes(flag)
        ? rule.flags
        : [...rule.flags, flag].join("")
      : [...rule.flags].filter((item) => item !== flag).join("");
    onUpdate(index, { flags });
  }

  return (
    <div className={`cleaning-rule-row${rule.enabled ? "" : " disabled"}`}>
      <div className="cleaning-rule-row-header">
        <input
          type="checkbox"
          checked={rule.enabled}
          title={rule.enabled ? "已启用" : "已停用"}
          aria-label={`启用 ${rule.name}`}
          onChange={(event) => onUpdate(index, { enabled: event.target.checked })}
        />
        <input
          className="cleaning-rule-name"
          value={rule.name}
          placeholder="规则名称"
          aria-label="规则名称"
          onChange={(event) => onUpdate(index, { name: event.target.value })}
        />
        <select
          className="cleaning-rule-mode"
          value={rule.mode}
          aria-label="规则模式"
          onChange={(event) => onUpdate(index, { mode: event.target.value as CleaningRuleMode })}
        >
          <option value="discard">去掉</option>
          <option value="keep">保留</option>
        </select>
        <button
          type="button"
          className="icon-button"
          title="上移"
          aria-label="上移"
          disabled={index === 0}
          onClick={() => onMove(index, -1)}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="下移"
          aria-label="下移"
          disabled={index === ruleCount - 1}
          onClick={() => onMove(index, 1)}
        >
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="删除"
          aria-label="删除"
          onClick={() => onRemove(index)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="cleaning-rule-row-body">
        <input
          className="cleaning-rule-pattern"
          value={rule.pattern}
          placeholder="正则表达式，如 \* 或 【([^】]+)】"
          aria-label="正则表达式"
          spellCheck={false}
          onChange={(event) => onUpdate(index, { pattern: event.target.value })}
        />
        <span className="cleaning-rule-flags">
          {CLEANING_RULE_FLAGS.map((flag) => (
            <label key={flag}>
              <input
                type="checkbox"
                checked={rule.flags.includes(flag)}
                onChange={(event) => toggleFlag(flag, event.target.checked)}
              />
              {flag}
            </label>
          ))}
        </span>
      </div>
      {error ? <p className="cleaning-rule-error">{error}</p> : null}
    </div>
  );
}
