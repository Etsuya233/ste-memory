import { useEffect, useRef, useState } from "react";
import { Button, FormField, FormSection, Input, Switch } from "../kit/controls.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { reportSuccess } from "../shell/ui-helpers.tsx";
import {
  parseRerankSettings,
  type RerankConnection,
  type RerankSettings,
} from "../../features/settings/rerank-settings.ts";

const EMPTY_CONNECTION: RerankConnection = {
  endpoint: "",
  apiKey: "",
  model: "",
  maxInputChars: 8000,
  timeoutSeconds: 30,
};
const CONNECTION_FIELDS = [
  {
    key: "endpoint",
    label: "完整重排端点",
    type: "url",
    placeholder: "https://example.com/v1/rerank",
  },
  { key: "apiKey", label: "API Key", type: "password", placeholder: "" },
  { key: "model", label: "Rerank 模型", type: "text", placeholder: "模型标识" },
  { key: "maxInputChars", label: "单条输入字符上限", type: "number", placeholder: "" },
  { key: "timeoutSeconds", label: "请求超时（秒）", type: "number", placeholder: "" },
] as const;

export function RerankConnectionEditor(props: {
  readonly settings: RerankSettings;
  readonly onSave: (settings: RerankSettings) => Promise<void>;
  readonly onClose: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const [enabled, setEnabled] = useState(props.settings.enabled);
  const [candidateLimit, setCandidateLimit] = useState(props.settings.candidateLimit);
  const [connection, setConnection] = useState(() => props.settings.connection ?? EMPTY_CONNECTION);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const initial = useRef(JSON.stringify({ enabled, candidateLimit, connection }));
  const dirty = useRef(false);
  dirty.current = initial.current !== JSON.stringify({ enabled, candidateLimit, connection });
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !dirty.current || window.confirm("重排连接有未保存的修改，放弃修改并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);

  async function persist(remove = false) {
    setError("");
    setSaving(true);
    try {
      const next = parseRerankSettings({
        enabled: remove ? false : enabled,
        candidateLimit,
        connection: remove ? undefined : connection,
      });
      await props.onSave(next);
      const nextConnection = next.connection ?? EMPTY_CONNECTION;
      setEnabled(next.enabled);
      setConnection(nextConnection);
      initial.current = JSON.stringify({
        enabled: next.enabled,
        candidateLimit,
        connection: nextConnection,
      });
      dirty.current = false;
      reportSuccess(remove ? "重排连接已移除，默认重排已关闭" : "重排设置已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="stm-setting-group-body stm-vector-connection"
      data-stm-section="rerank-connection"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void persist();
      }}
    >
      <PageChrome
        header={
          <PanelBar
            title="重排连接"
            leading={
              <PanelBarAction
                icon="fa-arrow-left"
                label="返回设置"
                data-action="settings-back"
                disabled={saving}
                onClick={props.onClose}
              />
            }
          />
        }
      />
      <FormSection title="默认行为" disabled={saving}>
        <FormField label="语义查询默认启用 rerank">
          {(field) => (
            <Switch
              {...field}
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          )}
        </FormField>
        <FormField label="默认候选数量（1–200）">
          {(field) => (
            <Input
              {...field}
              type="number"
              min={1}
              max={200}
              step={1}
              value={candidateLimit}
              onChange={(event) => setCandidateLimit(Number(event.target.value))}
            />
          )}
        </FormField>
      </FormSection>
      <FormSection title="服务" disabled={saving}>
        {CONNECTION_FIELDS.map(({ key, label, type, placeholder }) => (
          <FormField key={key} label={label}>
            {(field) => (
              <Input
                {...field}
                type={type}
                placeholder={placeholder}
                value={connection[key]}
                autoComplete={type === "password" ? "new-password" : "off"}
                onChange={(event) =>
                  setConnection({
                    ...connection,
                    [key]: type === "number" ? Number(event.target.value) : event.target.value,
                  })
                }
              />
            )}
          </FormField>
        ))}
      </FormSection>
      <p className="stm-setting-hint">
        使用 Cohere 兼容的 query / documents
        重排协议，请填写完整路径。浏览器直接请求，服务须允许当前站点跨域访问；密钥明文保存在插件设置中。
        重排文本默认使用所选向量组的字段。语义宏启用后每次适用生成都会计算，即使提示词没有引用。
      </p>
      <p className="stm-setting-hint">
        SQL 使用 WHERE s.rank IS NOT NULL ORDER BY s.rank 跟随默认排序；旧 ORDER BY s.score
        仍按余弦分排序。 可通过第四参数 {`'{"rerank":false}'`}{" "}
        单次关闭。输入超限或重排失败会显示错误，宏将输出为空。 embedding 与 rerank
        共用本次语义计算的 10 秒总预算。
      </p>
      {error && (
        <div className="stm-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="stm-editor-actions">
        <Button type="submit" variant="primary" disabled={saving}>
          保存重排设置
        </Button>
        {props.settings.connection && (
          <Button
            variant="danger"
            disabled={saving}
            onClick={() => {
              if (window.confirm("移除重排连接并关闭默认重排？")) void persist(true);
            }}
          >
            移除连接
          </Button>
        )}
      </div>
    </form>
  );
}
