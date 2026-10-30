import { useState } from "react";
import {
  validateAutoFillSettings,
  type AutoFillSettings,
} from "../../../features/fill-tasks/auto-fill-settings.ts";
import { FieldDescription, FieldGroup } from "../../primitives/field.tsx";
import { AutoFillFields } from "../../components/auto-fill-fields.tsx";
import { PageSection } from "../../components/page-section.tsx";
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
      <PageSection
        title="自动填表"
        meta={
          <span className="ste:text-xs ste:text-muted-foreground">全局默认 · 对话设置可覆盖</span>
        }
      >
        <FieldGroup className="ste:gap-5">
          <FieldDescription>
            每次 AI 回复完成后按楼层间隔检查；用户和 AI 消息均计入楼层。
          </FieldDescription>
          <AutoFillFields
            kind="global"
            idPrefix="auto-fill"
            disabled={busy}
            value={draft}
            onChange={setDraft}
          />
        </FieldGroup>
      </PageSection>
    </SettingsEditor>
  );
}
