import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../primitives/field.tsx";
import { ConfirmAction } from "../../components/confirmation.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { MAX_RERANK_CANDIDATES } from "../../../features/semantic-query/semantic-options.ts";
import {
  parseRerankSettings,
  type RerankSettings,
} from "../../../features/settings/rerank-settings.ts";
import {
  SettingsEditor,
  SecretInput,
  type SettingsSubpageProps,
} from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";

function draftFromSettings(settings: RerankSettings) {
  return {
    enabled: settings.enabled,
    candidateLimit: String(settings.candidateLimit),
    endpoint: settings.connection?.endpoint ?? "",
    apiKey: settings.connection?.apiKey ?? "",
    model: settings.connection?.model ?? "",
    maxInputChars: String(settings.connection?.maxInputChars ?? 8000),
    timeoutSeconds: String(settings.connection?.timeoutSeconds ?? 30),
  };
}

export function RerankSettingsPage({
  services,
  controls,
  onBack,
  registerLeaveGuard,
}: SettingsSubpageProps) {
  const [initial, setInitial] = useState(() => draftFromSettings(services.settings.read().rerank));
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const needsConnection =
    draft.enabled || Boolean(draft.endpoint.trim() || draft.model.trim() || draft.apiKey.trim());
  async function persist(remove = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = parseRerankSettings({
        enabled: remove ? false : draft.enabled,
        candidateLimit: Number(draft.candidateLimit),
        connection:
          remove || !needsConnection
            ? undefined
            : {
                endpoint: draft.endpoint.trim(),
                apiKey: draft.apiKey.trim(),
                model: draft.model.trim(),
                maxInputChars: Number(draft.maxInputChars),
                timeoutSeconds: Number(draft.timeoutSeconds),
              },
      });
      const result = await persistSettingsEdit(
        services,
        () => services.settings.setRerankSettings(settings),
        (value) => JSON.stringify(value.rerank) === JSON.stringify(settings),
      );
      if (result.saved) {
        const next = draftFromSettings(result.settings.rerank);
        setInitial(next);
        setDraft(next);
        setNotice(remove ? "重排连接已移除，默认重排已关闭。" : "重排设置已保存。");
      }
      if (result.error)
        setError(`${result.saved ? "配置已保存，后续刷新失败" : "配置未保存"}：${result.error}`);
      if (remove && !result.saved) throw new Error(result.error ?? "连接未移除");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (remove) throw cause;
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsEditor
      title="重排设置"
      scope="settings-rerank"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(initial)}
      onSave={() => void persist()}
      error={error}
      notice={notice}
    >
      <PageSection
        title="重排行为"
        meta={
          <span className="ste:text-xs ste:text-muted-foreground">
            {draft.enabled ? "已启用" : "未启用"}
          </span>
        }
      >
        <FieldGroup className="ste:gap-5">
          <SwitchField
            label="默认启用重排"
            description="对语义检索候选结果进行相关性重排，开启前需要配置连接。"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          <Field>
            <FieldLabel htmlFor="rerank-candidates">默认候选数</FieldLabel>
            <Input
              id="rerank-candidates"
              type="number"
              min={1}
              max={MAX_RERANK_CANDIDATES}
              step={1}
              required
              value={draft.candidateLimit}
              onChange={(event) => setDraft({ ...draft, candidateLimit: event.target.value })}
            />
            <FieldDescription>范围 1–{MAX_RERANK_CANDIDATES}；检索时可单独调整。</FieldDescription>
          </Field>
        </FieldGroup>
      </PageSection>
      <PageSection title="重排连接">
        <FieldGroup className="ste:gap-5">
          <Field>
            <FieldLabel htmlFor="rerank-url">完整重排端点</FieldLabel>
            <Input
              id="rerank-url"
              type="url"
              required={needsConnection}
              placeholder="https://example.com/v1/rerank"
              value={draft.endpoint}
              onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
            />
            <FieldDescription>
              浏览器直接请求服务的重排接口，需要允许当前站点跨域访问。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="rerank-key">API Key</FieldLabel>
            <SecretInput
              id="rerank-key"
              label="重排 API Key"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rerank-model">Rerank 模型</FieldLabel>
            <Input
              id="rerank-model"
              required={needsConnection}
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rerank-chars">单条输入字符上限</FieldLabel>
            <Input
              id="rerank-chars"
              type="number"
              required
              min={1}
              max={100000}
              step={1}
              value={draft.maxInputChars}
              onChange={(event) => setDraft({ ...draft, maxInputChars: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rerank-timeout">请求超时（秒）</FieldLabel>
            <Input
              id="rerank-timeout"
              type="number"
              required
              min={1}
              max={1800}
              step={1}
              value={draft.timeoutSeconds}
              onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
            />
          </Field>
        </FieldGroup>
      </PageSection>
      {services.settings.read().rerank.connection ? (
        <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>
          <Trash2 />
          移除重排连接
        </Button>
      ) : null}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title="移除重排连接？"
        description="同时关闭默认重排，语义检索仍可使用向量相似度排序。"
        confirmLabel="移除连接"
        destructive
        onConfirm={() => persist(true)}
      />
    </SettingsEditor>
  );
}
