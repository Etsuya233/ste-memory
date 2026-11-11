import { useState } from "react";
import { validateHistorySettings } from "../../../features/memory-history/history.ts";
import { SwitchField } from "../../components/form-fields.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../primitives/field.tsx";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";

export function MemoryHistorySettingsPage({
  services,
  controls,
  onBack,
  registerLeaveGuard,
}: SettingsSubpageProps) {
  const [saved, setSaved] = useState(() => services.settings.read().history);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [interval, setInterval] = useState(String(saved.interval));
  const [limit, setLimit] = useState(String(saved.limit));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dirty =
    enabled !== saved.enabled ||
    interval !== String(saved.interval) ||
    limit !== String(saved.limit);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const value = { enabled, interval: Number(interval), limit: Number(limit) };
      validateHistorySettings(value);
      const result = await persistSettingsEdit(
        services,
        () => services.settings.setHistorySettings(value),
        (settings) =>
          settings.history.enabled === value.enabled &&
          settings.history.interval === value.interval &&
          settings.history.limit === value.limit,
      );
      if (result.saved) {
        setSaved(result.settings.history);
        setEnabled(result.settings.history.enabled);
        setInterval(String(result.settings.history.interval));
        setLimit(String(result.settings.history.limit));
      }
      setNotice({
        text: result.error
          ? `${result.saved ? "设置已保存，后续处理失败" : "设置未保存"}：${result.error}`
          : "历史版本设置已保存。",
        error: Boolean(result.error),
      });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      setBusy(false);
    }
  }
  async function retryTrim() {
    setBusy(true);
    setNotice(null);
    try {
      await services.settings.trimHistoryVersions();
      setNotice({ text: "历史版本清理完成。", error: false });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setNotice({ text: `设置已保存，${detail}`, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsEditor
      title="自动保存设置"
      scope="memory-history-settings"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => {
        setEnabled(saved.enabled);
        setInterval(String(saved.interval));
        setLimit(String(saved.limit));
      }}
      onSave={() => void save()}
      error={notice?.error ? notice.text : null}
      notice={notice && !notice.error ? notice.text : null}
    >
      {services.settings.historyTrimPending && (
        <Button
          type="button"
          variant="outline"
          className="ste:self-start"
          onClick={() => void retryTrim()}
        >
          重试历史清理
        </Button>
      )}
      <PageSection title="历史版本自动保存">
        <FieldGroup className="ste:gap-5">
          <SwitchField
            label="填表成功后自动保存版本"
            description="首次成功填表并保存后建立版本，之后按新增处理楼层累计。关闭后仍可手动保存，恢复前仍会保存当前版本。"
            checked={enabled}
            disabled={busy}
            onCheckedChange={setEnabled}
          />
          <Field>
            <FieldLabel htmlFor="memory-history-interval">保存间隔（层）</FieldLabel>
            <Input
              id="memory-history-interval"
              type="number"
              min={1}
              step={1}
              required
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="memory-history-limit">每个对话保留的自动版本（份）</FieldLabel>
            <Input
              id="memory-history-limit"
              type="number"
              min={1}
              step={1}
              required
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              aria-describedby="memory-history-limit-description"
            />
            <FieldDescription id="memory-history-limit-description">
              填表自动版本与恢复前版本共用上限，超出后删除最旧版本。手动保存的版本由你删除。
            </FieldDescription>
          </Field>
        </FieldGroup>
      </PageSection>
    </SettingsEditor>
  );
}
