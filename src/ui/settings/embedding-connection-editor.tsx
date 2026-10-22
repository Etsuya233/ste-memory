import { useState } from "react";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";

type Connection = NonNullable<PluginSettings["embeddingConnection"]>;

export function EmbeddingConnectionEditor(props: {
  readonly connection?: Connection;
  readonly onSave: (connection: Connection | undefined) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Connection>(
    () =>
      props.connection ?? {
        baseUrl: "",
        apiKey: "",
        model: "",
        maxInputChars: 8000,
        timeoutSeconds: 120,
      },
  );
  const [dimensionsText, setDimensionsText] = useState(
    () => props.connection?.dimensions?.toString() ?? "",
  );
  const [error, setError] = useState("");

  function save(): void {
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setError("请填写端点和模型");
      return;
    }
    if (!Number.isSafeInteger(draft.maxInputChars) || draft.maxInputChars <= 0) {
      setError("字符上限需为正整数");
      return;
    }
    if (!Number.isSafeInteger(draft.timeoutSeconds) || draft.timeoutSeconds <= 0) {
      setError("超时秒数需为正整数");
      return;
    }
    const dimensions = dimensionsText.trim() ? Number(dimensionsText) : undefined;
    if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions <= 0)) {
      setError("向量维度需为正整数");
      return;
    }
    void props.onSave({
      ...draft,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      dimensions,
    });
    setError("");
  }

  return (
    <div
      className="stm-setting-group-body stm-vector-connection"
      data-stm-section="embedding-connection"
    >
      <p className="stm-setting-hint">
        向量化会将选中字段文本直接发送到此 embedding 端点。请确保端点允许当前 SillyTavern
        站点跨域访问。支持 OpenAI 兼容的 /embeddings 路径；可填写 /v1 基础地址或完整 /embeddings
        地址。
      </p>
      <label className="stm-form-row">
        <span className="stm-form-label">端点</span>
        <input
          className="stm-input"
          type="url"
          value={draft.baseUrl}
          placeholder="https://example.com/v1"
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
        />
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">API Key</span>
        <input
          className="stm-input"
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
        />
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">Embedding 模型</span>
        <input
          className="stm-input"
          value={draft.model}
          placeholder="模型标识"
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        />
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">输入字符上限</span>
        <input
          className="stm-input"
          type="number"
          min="1"
          step="1"
          value={draft.maxInputChars}
          onChange={(event) => setDraft({ ...draft, maxInputChars: Number(event.target.value) })}
        />
      </label>
      <p className="stm-setting-hint">
        按服务文档填写字符上限；字符数不能代替 token
        数，服务返回的长度错误会显示在对应向量任务中。默认 8000 字符须按所选模型核对。
      </p>
      <label className="stm-form-row">
        <span className="stm-form-label">向量维度（可选）</span>
        <input
          className="stm-input"
          type="number"
          min="1"
          step="1"
          value={dimensionsText}
          onChange={(event) => setDimensionsText(event.target.value)}
        />
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">请求超时（秒）</span>
        <input
          className="stm-input"
          type="number"
          min="1"
          step="1"
          value={draft.timeoutSeconds}
          onChange={(event) => setDraft({ ...draft, timeoutSeconds: Number(event.target.value) })}
        />
      </label>
      {error && (
        <div className="stm-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="stm-editor-actions">
        <button type="button" className="stm-button stm-button--primary" onClick={save}>
          保存连接
        </button>
        {props.connection && (
          <button
            type="button"
            className="stm-button stm-button--danger"
            onClick={() => void props.onSave(undefined)}
          >
            移除连接
          </button>
        )}
      </div>
    </div>
  );
}
