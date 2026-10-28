import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../../ui/primitives/field.tsx";
import { ConfirmAction } from "../../components/confirmation.tsx";
import {
  parseEmbeddingConnection,
  type EmbeddingConnection,
} from "../../../features/settings/embedding-connection.ts";
import {
  SettingsEditor,
  SecretInput,
  type SettingsSubpageProps,
} from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";

function draftFromConnection(connection: EmbeddingConnection | undefined) {
  return {
    baseUrl: connection?.baseUrl ?? "",
    apiKey: connection?.apiKey ?? "",
    model: connection?.model ?? "",
    maxInputChars: String(connection?.maxInputChars ?? 8000),
    timeoutSeconds: String(connection?.timeoutSeconds ?? 120),
    dimensions: connection?.dimensions?.toString() ?? "",
  };
}

export function EmbeddingSettingsPage({
  services,
  controls,
  onBack,
  registerLeaveGuard,
}: SettingsSubpageProps) {
  const [initial, setInitial] = useState(() =>
    draftFromConnection(services.settings.read().embeddingConnection),
  );
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  async function persist(remove = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const connection = remove
        ? undefined
        : parseEmbeddingConnection({
            ...draft,
            maxInputChars: Number(draft.maxInputChars),
            timeoutSeconds: Number(draft.timeoutSeconds),
            dimensions: draft.dimensions.trim() ? Number(draft.dimensions) : undefined,
          });
      const result = await persistSettingsEdit(
        services,
        () => services.settings.setEmbeddingConnection(connection),
        (settings) => JSON.stringify(settings.embeddingConnection) === JSON.stringify(connection),
      );
      if (result.saved) {
        const next = draftFromConnection(result.settings.embeddingConnection);
        setInitial(next);
        setDraft(next);
        setNotice(remove ? "向量连接已移除。" : "向量连接已保存，新的索引请求会使用此配置。");
      }
      if (result.error)
        setError(
          `${result.saved ? "配置已保存，后续索引刷新失败" : "配置未保存"}：${result.error}`,
        );
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
      title="Embedding 连接"
      scope="settings-embedding"
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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="embedding-url">API Base URL</FieldLabel>
          <Input
            id="embedding-url"
            type="url"
            value={draft.baseUrl}
            required
            placeholder="https://example.com/v1"
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
          <FieldDescription>
            浏览器直接调用 /embeddings 接口，服务需允许当前 SillyTavern 站点跨域访问。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="embedding-key">API Key</FieldLabel>
          <SecretInput
            id="embedding-key"
            label="Embedding API Key"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="embedding-model">Embedding 模型</FieldLabel>
          <Input
            id="embedding-model"
            value={draft.model}
            required
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="embedding-chars">单条输入字符上限</FieldLabel>
          <Input
            id="embedding-chars"
            type="number"
            min={1}
            step={1}
            value={draft.maxInputChars}
            required
            onChange={(event) => setDraft({ ...draft, maxInputChars: event.target.value })}
          />
          <FieldDescription>这是本地字符限制；模型的 token 上限由服务校验。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="embedding-timeout">请求超时（秒）</FieldLabel>
          <Input
            id="embedding-timeout"
            type="number"
            min={1}
            max={1800}
            step={1}
            value={draft.timeoutSeconds}
            required
            onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="embedding-dimensions">向量维度（可留空）</FieldLabel>
          <Input
            id="embedding-dimensions"
            type="number"
            min={1}
            step={1}
            value={draft.dimensions}
            onChange={(event) => setDraft({ ...draft, dimensions: event.target.value })}
          />
          <FieldDescription>
            留空使用模型默认维度。更换模型或维度后需要重新生成相应索引。
          </FieldDescription>
        </Field>
      </FieldGroup>
      {services.settings.read().embeddingConnection ? (
        <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>
          <Trash2 />
          移除向量连接
        </Button>
      ) : null}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title="移除向量连接？"
        description="之后无法提交索引和语义检索请求，记忆正文与已有索引会保留。"
        confirmLabel="移除连接"
        destructive
        onConfirm={() => persist(true)}
      />
    </SettingsEditor>
  );
}
