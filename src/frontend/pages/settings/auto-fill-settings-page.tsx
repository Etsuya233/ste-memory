import { useState } from "react";
import {
  validateAutoFillSettings,
  type AutoFillSettings,
} from "../../../features/fill-tasks/auto-fill-settings.ts";
import { AutoFillFields } from "../../components/auto-fill-fields.tsx";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";

export function AutoFillSettingsPage({
  services,
  controls,
  onBack,
  registerLeaveGuard,
}: SettingsSubpageProps) {
  const [saved, setSaved] = useState(() => services.settings.read().autoFill);
  const [draft, setDraft] = useState<AutoFillSettings>(saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      validateAutoFillSettings(draft);
      const result = await persistSettingsEdit(
        services,
        () => services.settings.save({ ...services.settings.read(), autoFill: draft }),
        (settings) => JSON.stringify(settings.autoFill) === JSON.stringify(draft),
      );
      if (result.saved) {
        setSaved(result.settings.autoFill);
        setDraft(result.settings.autoFill);
      }
      setNotice({
        text: result.error
          ? `${result.saved ? "设置已保存，后续刷新失败" : "设置未保存"}：${result.error}`
          : "自动填表设置已保存。",
        error: !!result.error,
      });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsEditor
      title="自动填表"
      scope="global-auto-fill"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(saved)}
      onSave={() => void save()}
      error={notice?.error ? notice.text : null}
      notice={notice && !notice.error ? notice.text : null}
    >
      <p className="ste:text-sm ste:text-muted-foreground">
        AI 回复完成后检查间隔。用户和 AI 消息均计入楼层；对话单独设置的值优先于这里的全局值。
      </p>
      <AutoFillFields
        kind="global"
        idPrefix="auto-fill"
        disabled={busy}
        value={draft}
        onChange={setDraft}
      />
    </SettingsEditor>
  );
}
