import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import type { LlmConfigInfo, LlmWebConfig } from "../api/chat.ts";

interface LlmConfigFormProps {
  readonly config: LlmWebConfig;
  /** 服务端环境回退信息；拉取失败时为 undefined（不阻塞聊天，只影响来源标注）。 */
  readonly envInfo?: LlmConfigInfo;
  readonly onChange: (patch: Partial<LlmWebConfig>) => void;
}

type SourceBadge = "web" | "env" | "default" | "missing";

function badgeText(source: SourceBadge, label: string): string {
  switch (source) {
    case "web":
      return "网页配置";
    case "env":
      return "环境变量";
    case "default":
      return `默认 ${label}`;
    case "missing":
      return "未配置";
  }
}

export function LlmConfigForm({ config, envInfo, onChange }: LlmConfigFormProps) {
  // 与服务端一致：空白视为未填写（服务端 trim 后回退环境变量），徽标据此标注生效来源
  const baseUrl = config.baseUrl.trim();
  const model = config.model.trim();
  const apiKey = config.apiKey.trim();
  const baseUrlSource: SourceBadge = baseUrl ? "web" : envInfo?.env.baseUrl ? "env" : "default";
  const modelSource: SourceBadge = model ? "web" : envInfo?.env.model ? "env" : "missing";
  const apiKeySource: SourceBadge = apiKey
    ? "web"
    : envInfo?.env.apiKeyConfigured
      ? "env"
      : "missing";

  return (
    <details className="llm-config">
      <summary>
        <KeyRound size={14} /> LLM 配置
        <span className="config-summary-hint">
          {apiKeySource === "missing" ? "未配置 API Key" : "已配置"}
        </span>
      </summary>
      <div className="llm-config-body">
        <label className="config-field">
          <span>
            Base URL
            <em className="config-badge" data-source={baseUrlSource}>
              {badgeText(baseUrlSource, "api.openai.com/v1")}
            </em>
          </span>
          <input
            type="text"
            placeholder="留空使用环境变量或默认值"
            value={config.baseUrl}
            onChange={(event) => {
              onChange({ baseUrl: event.target.value });
            }}
          />
        </label>
        <label className="config-field">
          <span>
            Model
            <em className="config-badge" data-source={modelSource}>
              {badgeText(modelSource, "")}
            </em>
          </span>
          <input
            type="text"
            placeholder="如 gpt-4o-mini"
            value={config.model}
            onChange={(event) => {
              onChange({ model: event.target.value });
            }}
          />
        </label>
        <label className="config-field">
          <span>
            API Key
            <em className="config-badge" data-source={apiKeySource}>
              {badgeText(apiKeySource, "")}
            </em>
          </span>
          <div className="config-key-row">
            <input
              type="password"
              placeholder="留空使用环境变量"
              value={config.apiKey}
              onChange={(event) => {
                onChange({ apiKey: event.target.value });
              }}
            />
            {config.apiKey ? (
              <button
                className="icon-button"
                type="button"
                title="清除（仅清除本页内存中的 Key）"
                aria-label="清除 API Key"
                onClick={() => onChange({ apiKey: "" })}
              >
                <Trash2 size={15} />
              </button>
            ) : null}
          </div>
        </label>
        <p className="config-notes">
          <ShieldCheck size={13} />
          API Key 仅保存在当前页面内存中，刷新即失效；Base URL / Model 会自动保存到浏览器本地。
        </p>
        {envInfo === undefined ? (
          <p className="config-notes config-notes-warn">
            无法读取服务端环境配置，来源标注可能不准确
          </p>
        ) : null}
      </div>
    </details>
  );
}
