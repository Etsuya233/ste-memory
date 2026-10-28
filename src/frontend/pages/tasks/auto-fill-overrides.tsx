import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../../ui/primitives/button.tsx";
import type { AutoFillSettings } from "../../../features/fill-tasks/auto-fill-settings.ts";
import type { RecordsContext } from "../records-workspace.ts";
import type { TasksWorkspace } from "./tasks-workspace.ts";
import { AutoFillFields } from "../../components/auto-fill-fields.tsx";
import type { PageControls } from "../../components/page-layout.tsx";
import { PageEmpty } from "../../components/page-state.tsx";
import type { RegisterLeaveGuard } from "../../components/confirmation.tsx";
import { SettingsEditor } from "../settings/connection-settings-editor.tsx";
import {
  overridesDirty,
  saveAutoFillOverrides,
  type AutoFillServices,
} from "./auto-fill-overrides-model.ts";
export type { AutoFillServices } from "./auto-fill-overrides-model.ts";

interface Session {
  context: RecordsContext;
  saved: Partial<AutoFillSettings>;
  draft: Partial<AutoFillSettings>;
  effective: AutoFillSettings;
}
export function AutoFillOverrides({
  workspace,
  autoFill,
  controls,
  onBack,
  registerLeaveGuard,
}: {
  workspace: TasksWorkspace;
  autoFill: AutoFillServices;
  controls: PageControls;
  onBack: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  const { context } = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const scope = JSON.stringify([context?.chatKey, context?.spaceId]);
  const [sessions, setSessions] = useState(new Map<string, Session>());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    setNotice(null);
    if (!context) return;
    try {
      autoFill.assertContext(context);
      const saved = autoFill.read().overrides;
      const effective = autoFill.settings();
      setSessions((previous) => {
        const current = previous.get(scope);
        if (current && overridesDirty(current.saved, current.draft)) return previous;
        return new Map(previous).set(scope, {
          context,
          saved,
          draft: saved,
          effective,
        });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [autoFill, scope]);
  const session = sessions.get(scope);
  const anyDirty = [...sessions.values()].some((item) => overridesDirty(item.saved, item.draft));
  function discardAll() {
    setSessions(
      (previous) =>
        new Map([...previous].map(([key, item]) => [key, { ...item, draft: item.saved }])),
    );
  }
  const dirty = !!session && overridesDirty(session.saved, session.draft);
  function change(draft: Partial<AutoFillSettings>) {
    setSessions((previous) => new Map(previous).set(scope, { ...session!, draft }));
    setError(null);
    setNotice(null);
  }
  function save() {
    setError(null);
    setNotice(null);
    try {
      const saved = saveAutoFillOverrides(
        autoFill,
        session!.context,
        session!.saved,
        session!.draft,
      );
      const effective = autoFill.settings();
      setSessions((previous) =>
        new Map(previous).set(scope, {
          ...session!,
          saved,
          draft: saved,
          effective,
        }),
      );
      setNotice("当前对话的自动填表设置已保存。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <SettingsEditor
      title="对话自动填表"
      subtitle="当前对话覆盖设置"
      scope="chat-auto-fill"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      navigationDirty={anyDirty}
      busy={false}
      onDiscard={discardAll}
      onSave={save}
      error={error}
      notice={notice}
    >
      <p className="ste:text-sm ste:font-medium">{context?.title ?? "尚未打开对话"}</p>
      <p className="ste:text-xs ste:text-muted-foreground">
        选择“跟随全局”或将数字留空，可移除此项对话覆盖。切换对话会保留各自草稿；离开此页时会确认所有尚未保存的对话设置。
      </p>
      {context && session ? (
        <>
          <AutoFillFields
            kind="overrides"
            idPrefix="chat-auto-fill"
            value={session.draft}
            onChange={change}
          />
          <Button type="button" variant="outline" onClick={() => change({})}>
            全部跟随全局
          </Button>
          <p className="ste:text-xs ste:text-muted-foreground">
            已保存的实际配置：
            {session.effective.mode === "off"
              ? "关闭"
              : session.effective.mode === "remind"
                ? "仅提醒"
                : "自动填表"}{" "}
            · 每 {session.effective.interval} 层触发 · 每批 {session.effective.blockSize} 层。
          </p>
        </>
      ) : !error ? (
        <PageEmpty
          title={context ? "正在读取对话设置…" : "请先打开对话"}
          description="绑定记忆空间后，可以为当前对话覆盖全局自动填表配置。"
        />
      ) : null}
    </SettingsEditor>
  );
}
