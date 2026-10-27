import { Input } from "../kit/controls.tsx";
/**
 * 宏设置页（原「宏设置」tab）：宏前缀（注册名）+ 每个宏的输出字符上限 +
 * 快照预算摘要 + 合并后的使用说明。改动即时保存（与设置其他项一致）。
 */
import { useEffect, useState } from "react";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { copyText, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import {
  defaultMacroToken,
  macroNameStatus,
  type MacroBudgetInfo,
  type MacroNameStatus,
} from "./macro-ui-model.ts";

/** 「记忆宏」组顶部的设置摘要条：宏前缀 + 默认快照体积/截断 + 进入宏设置。 */
export function MacroSettingsSummary(props: {
  readonly macroName: string;
  readonly macroLimit: number;
  readonly hasActiveSpace: boolean;
  readonly budget: MacroBudgetInfo | undefined;
  readonly onOpen: () => void;
}) {
  const status = macroNameStatus(props.macroName);
  const token = status.kind === "valid" ? defaultMacroToken(status.registrationName) : "";
  const truncated = props.budget?.truncatedCount ?? 0;
  const meta =
    status.kind === "valid"
      ? [
          `最近执行 ${props.budget?.defaultCharacters ?? 0} / ${props.macroLimit} 字`,
          truncated > 0 ? `${truncated} 个宏已截断` : "",
          props.hasActiveSpace ? "" : "无活动空间",
        ]
          .filter((part) => part !== "")
          .join(" · ")
      : status.kind === "empty"
        ? "宏前缀为空，记忆宏不会注入"
        : "宏前缀无效，当前不会注册";
  return (
    <button
      type="button"
      className="stm-macro-status"
      data-action="open-macro-settings"
      data-stm-field="macro-status"
      data-state={status.kind}
      onClick={props.onOpen}
      aria-label={`打开宏设置：${token === "" ? meta : `${token}，${meta}`}`}
    >
      <span className="stm-macro-status-icon" aria-hidden="true">
        <i className="fa-solid fa-gear" />
      </span>
      <span className="stm-macro-status-main">
        <span className="stm-macro-status-title">
          {token === "" ? (
            status.kind === "empty" ? (
              "未配置宏前缀"
            ) : (
              "宏前缀无效"
            )
          ) : (
            <span className="stm-mono">{token}</span>
          )}
        </span>
        <span className="stm-macro-status-meta">{meta}</span>
      </span>
      <i className="fa-solid fa-chevron-right stm-macro-status-chevron" aria-hidden="true" />
    </button>
  );
}

export function MacroSettingsPage(props: {
  readonly macroName: string;
  readonly macroLimit: number;
  readonly hasActiveSpace: boolean;
  readonly budget: MacroBudgetInfo | undefined;
  readonly onNameChange: (value: string) => void;
  readonly onLimitChange: (value: number) => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="stm-settings-detail-page" data-stm-section="macro-settings-page">
      <PageChrome
        pageKey="macro-settings"
        header={
          <PanelBar
            title="宏设置"
            leading={
              <PanelBarAction
                icon="fa-arrow-left"
                label="返回记忆宏"
                data-action="close-macro-settings"
                onClick={props.onBack}
              />
            }
          />
        }
      />
      <MacroSettingsFields
        macroName={props.macroName}
        macroLimit={props.macroLimit}
        hasActiveSpace={props.hasActiveSpace}
        budget={props.budget}
        onNameChange={props.onNameChange}
        onLimitChange={props.onLimitChange}
      />
    </div>
  );
}

/** 设置表单主体（无页面栏；可独立用于组件测试）。 */
export function MacroSettingsFields(props: {
  readonly macroName: string;
  readonly macroLimit: number;
  readonly hasActiveSpace: boolean;
  readonly budget: MacroBudgetInfo | undefined;
  readonly onNameChange: (value: string) => void;
  readonly onLimitChange: (value: number) => void;
}) {
  const status = macroNameStatus(props.macroName);
  const [limitText, setLimitText] = useState(String(props.macroLimit));
  useEffect(() => {
    setLimitText(String(props.macroLimit));
  }, [props.macroLimit]);

  const parsedLimit = Number(limitText);
  const limitValid = limitText.trim() !== "" && Number.isInteger(parsedLimit) && parsedLimit >= 0;
  const limitError = limitText.trim() !== "" && !limitValid ? "输出上限需为 0 或正整数" : undefined;

  function changeLimit(raw: string): void {
    setLimitText(raw);
    if (raw.trim() === "") return;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) props.onLimitChange(parsed);
  }

  function resetInvalidLimit(): void {
    if (!limitValid) setLimitText(String(props.macroLimit));
  }

  return (
    <div className="stm-setting-subgroup stm-macro-settings" data-stm-section="macro-settings">
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">宏前缀</div>
          <div className="stm-setting-hint">
            可填 ste 或 {"{{ste}}"}；字母开头，可含数字、下划线、连字符。改动即时生效。
          </div>
        </div>
        <Input
          type="text"
          data-stm-field="macro-name"
          value={props.macroName}
          placeholder="{{ste}}"
          onChange={(event) => props.onNameChange(event.target.value)}
        />
        <MacroNameStatusLine status={status} />
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">输出字符上限</div>
          <div className="stm-setting-hint">
            每个宏单独生效；按查询顺序装入完整记录或结果行，超出时标明省略；JSON 保持完整
          </div>
        </div>
        <Input
          type="number"
          min="0"
          step="100"
          data-stm-field="macro-limit"
          value={limitText}
          onChange={(event) => changeLimit(event.target.value)}
          onBlur={resetInvalidLimit}
        />
        {limitError !== undefined && (
          <div className="stm-preset-warning" data-stm-field="macro-limit-error">
            {limitError}
          </div>
        )}
      </div>
      <MacroBudgetCard
        status={status}
        budget={props.budget}
        limit={props.macroLimit}
        hasActiveSpace={props.hasActiveSpace}
      />
      <MacroSettingsHelp status={status} />
    </div>
  );
}

function MacroNameStatusLine(props: { readonly status: MacroNameStatus }) {
  if (props.status.kind === "valid") {
    const token = defaultMacroToken(props.status.registrationName);
    return (
      <div
        className="stm-macro-name-status"
        data-stm-field="macro-name-status"
        data-state="valid"
        aria-live="polite"
      >
        <span>
          已注册为 <span className="stm-mono">{token}</span>
        </span>
        <button
          type="button"
          className="stm-text-button"
          data-action="copy-default-macro"
          onClick={() =>
            void copyText(token)
              .then((copied) => {
                if (copied) reportSuccess(`已复制 ${token}`);
                else reportWarning("复制失败：浏览器不支持剪贴板写入");
              })
              .catch(() => reportWarning("复制失败：无法写入剪贴板"))
          }
        >
          复制
        </button>
      </div>
    );
  }
  return (
    <div
      className="stm-macro-name-status"
      data-stm-field="macro-name-status"
      data-state={props.status.kind}
      aria-live="polite"
    >
      {props.status.kind === "empty"
        ? "宏前缀为空：插件不会注册记忆宏，所有宏都不会注入。"
        : "宏前缀无效：需以字母开头，只含字母、数字、下划线、连字符；当前不会注册。"}
    </div>
  );
}

function MacroBudgetCard(props: {
  readonly status: MacroNameStatus;
  readonly budget: MacroBudgetInfo | undefined;
  readonly limit: number;
  readonly hasActiveSpace: boolean;
}) {
  if (props.status.kind !== "valid") {
    return (
      <div className="stm-macro-budget" data-stm-field="macro-budget">
        <div className="stm-macro-budget-head">
          <span>最近执行输出</span>
        </div>
        <div className="stm-setting-hint">配置有效宏前缀后显示输出体积与截断状态。</div>
      </div>
    );
  }
  if (!props.hasActiveSpace) {
    return (
      <div className="stm-macro-budget" data-stm-field="macro-budget">
        <div className="stm-macro-budget-head">
          <span>最近执行输出</span>
          <span>无活动空间</span>
        </div>
        <div className="stm-setting-hint">
          实际生成或显式测试后可查看执行结果；打开页面不会运行查询。
        </div>
      </div>
    );
  }
  const characters = props.budget?.defaultCharacters ?? 0;
  const truncatedCount = props.budget?.truncatedCount ?? 0;
  const macroCount = props.budget?.macroCount ?? 0;
  const percent =
    props.limit <= 0 ? 0 : Math.min(100, Math.round((characters / props.limit) * 100));
  const over = props.limit <= 0 || characters > props.limit || truncatedCount > 0;
  return (
    <div className="stm-macro-budget" data-stm-field="macro-budget">
      <div className="stm-macro-budget-head">
        <span>最近真实执行输出</span>
        <span data-stm-field="macro-budget-value">
          {characters} / {props.limit} 字
        </span>
      </div>
      <div className="stm-macro-budget-track" aria-hidden="true">
        <div
          className="stm-macro-budget-fill"
          data-over={over ? "true" : "false"}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="stm-setting-hint" data-stm-field="macro-budget-hint">
        {props.limit <= 0
          ? "上限为 0：非空结果会报告预算不足。"
          : truncatedCount > 0
            ? `有 ${truncatedCount} 个宏的输出已按上限截断。`
            : macroCount === 0
              ? "还没有可展开的记忆宏。"
              : "所有宏输出都在上限内。"}
      </div>
    </div>
  );
}

function MacroSettingsHelp(props: { readonly status: MacroNameStatus }) {
  const prefix = props.status.kind === "valid" ? props.status.registrationName : "前缀";
  const defaultToken = `{{${prefix}}}`;
  const namedToken = `{{${prefix}::名字}}`;
  return (
    <Disclosure icon="fa-circle-info" title="使用说明" data-stm-field="macro-help">
      <div className="stm-macro-help">
        <div className="stm-setting-hint">
          实际生成前统一计算；刷新、编辑和打开最近结果不会执行查询。把宏放进提示词预设（角色卡 /
          系统提示 / 作者注释）或世界书条目内容。 世界书条目可在关键词命中时触发，也可设为常驻。
        </div>
        <div className="stm-macro-help-row">
          <span className="stm-mono">{defaultToken}</span>
          <span>全部启用表的分组快照</span>
        </div>
        <div className="stm-macro-help-row">
          <span className="stm-mono">{namedToken}</span>
          <span>对应全局宏或对话宏（同名对话宏优先）</span>
        </div>
        <div className="stm-macro-help-row">
          <span className="stm-mono">{`{{${prefix}::full}}`}</span>
          <span>全部启用表的完整数据（Markdown 表格）</span>
        </div>
        <div className="stm-macro-help-row">
          <span className="stm-mono">{`{{${prefix}::表Key}}`}</span>
          <span>单表完整数据</span>
        </div>
        <div className="stm-setting-hint">
          优先级：对话宏 &gt; 全局宏 &gt; 内置宏。全局宏按当前对话的空间求值；
          停用或错误的高优先级定义仍占位。表或字段缺失时展开为空，不阻断生成。字符上限按完整行控制预算。
        </div>
      </div>
    </Disclosure>
  );
}
