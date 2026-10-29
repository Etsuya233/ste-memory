import { useEffect, useState } from "react";
import { ChevronRight, Settings } from "lucide-react";
import type { ChatMirrorStatus } from "../../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import { AutoFillSettingsPage } from "./auto-fill-settings-page.tsx";
import { ConnectionsPage } from "./connections-page.tsx";
import { EmbeddingSettingsPage } from "./embedding-settings-page.tsx";
import { RerankSettingsPage } from "./rerank-settings-page.tsx";
import { CleaningRulesPage, type CleaningServices } from "./cleaning-rules-page.tsx";
import { MacrosPage, type MacroServices } from "./macros-page.tsx";
import { AgentPresetsPage } from "./agent-presets-page.tsx";
import { TablePresetsPage } from "./table-presets-page.tsx";
import type { PresetSettingsServices } from "./preset-settings-services.ts";
import type { RecordsContext } from "../records-workspace.ts";
import { LogsPage } from "../activity/logs-page.tsx";
import { MaintenancePage, type MaintenanceServices } from "../maintenance/maintenance-page.tsx";
import { QueryPage, type QueryServices } from "../query/query-page.tsx";
import { SqlPage, type SqlServices } from "../sql/sql-page.tsx";
import type { LogRepository } from "../../../features/logging/log.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../../ui/primitives/card.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import {
  saveFillTimeout,
  setSettingToggle,
  type SettingsSaveResult,
  type SettingsServices,
} from "./settings-actions.ts";

export type { SettingsServices } from "./settings-actions.ts";

export type SettingsSection =
  | "overview"
  | "connections"
  | "embedding"
  | "rerank"
  | "auto-fill"
  | "cleaning"
  | "macros"
  | "agent-presets"
  | "table-presets"
  | "logs"
  | "maintenance"
  | "query"
  | "sql";

export interface SettingsTools {
  logs: Pick<LogRepository, "recent" | "byKey" | "clearAll">;
  maintenance: MaintenanceServices;
  query: QueryServices;
  sql: SqlServices;
}

type SettingsPageProps = {
  services: SettingsServices;
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
  mirror: ChatMirrorStatus;
  cleaning: CleaningServices;
  macros: MacroServices;
  presets: PresetSettingsServices;
  context: RecordsContext | null;
  tools: SettingsTools;
  active: boolean;
};

export function SettingsPage(
  props: SettingsPageProps & {
    initialSection?: SettingsSection;
    initialLogKey?: string;
    logTitle?: string;
    logContext?: string;
    logBackLabel?: string;
    onLogBack?: () => void;
  },
) {
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? "overview");
  const detailProps = { ...props, onBack: () => setSection("overview") };
  if (section === "logs")
    return (
      <LogsPage
        logs={props.tools.logs}
        controls={props.controls}
        onBack={props.onLogBack ?? detailProps.onBack}
        title={props.logTitle}
        backLabel={props.logBackLabel}
        context={props.logContext}
        initialKey={props.initialLogKey}
      />
    );
  if (section === "maintenance")
    return <MaintenancePage {...detailProps} services={props.tools.maintenance} />;
  if (section === "query")
    return (
      <QueryPage
        {...props.tools.query}
        context={props.context}
        controls={props.controls}
        onBack={detailProps.onBack}
        registerLeaveGuard={props.registerLeaveGuard}
      />
    );
  if (section === "sql")
    return (
      <SqlPage
        {...props.tools.sql}
        context={props.context}
        controls={props.controls}
        onBack={detailProps.onBack}
        active={props.active}
      />
    );
  if (section === "cleaning")
    return (
      <CleaningRulesPage
        {...detailProps}
        contextKey={
          props.context ? JSON.stringify([props.context.chatKey, props.context.spaceId]) : null
        }
      />
    );
  if (section === "macros") return <MacrosPage {...detailProps} macroServices={props.macros} />;
  if (section === "agent-presets") return <AgentPresetsPage {...detailProps} />;
  if (section === "table-presets") return <TablePresetsPage {...detailProps} />;
  if (section === "connections") return <ConnectionsPage {...detailProps} />;
  if (section === "embedding") return <EmbeddingSettingsPage {...detailProps} />;
  if (section === "rerank") return <RerankSettingsPage {...detailProps} />;
  if (section === "auto-fill") return <AutoFillSettingsPage {...detailProps} />;
  return <SettingsOverview {...props} onOpen={setSection} />;
}

function SettingsOverview({
  services,
  controls,
  registerLeaveGuard,
  mirror,
  onOpen,
}: SettingsPageProps & { onOpen: (section: SettingsSection) => void }) {
  const scroll = usePageScroll(services, "settings-overview", true);
  const [settings, setSettings] = useState(() => services.settings.read());
  const [timeout, setTimeoutValue] = useState(() => String(settings.fillAgentTimeoutSeconds));
  const [savedTimeout, setSavedTimeout] = useState(timeout);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dirty = timeout !== savedTimeout;
  const { requestLeave, confirmation } = usePageLeave({
    dirty,
    busy,
    scope: "global-settings",
    register: registerLeaveGuard,
    discard: () => setTimeoutValue(savedTimeout),
  });
  useEffect(() => {
    if (!dirty && !busy) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty, busy]);

  async function save(operation: () => Promise<SettingsSaveResult>, timeoutChange = false) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      setSettings(result.settings);
      if (timeoutChange && result.saved) {
        const value = String(result.settings.fillAgentTimeoutSeconds);
        setTimeoutValue(value);
        setSavedTimeout(value);
      }
      setNotice({
        text: result.error
          ? `${result.saved ? "设置已保存，后续同步或界面刷新失败" : "设置未保存"}：${result.error}`
          : "设置已保存。",
        error: Boolean(result.error),
      });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="设置"
        subtitle={`全局设置 · v${services.version}`}
        icon={Settings}
        {...controls}
        busy={busy}
      />
      <PageContent ref={scroll.ref} onScroll={scroll.onScroll} className="ste:space-y-4">
        {notice ? (
          <StatusNotice variant={notice.error ? "destructive" : "default"}>
            {notice.text}
          </StatusNotice>
        ) : null}
        <Card size="sm">
          <CardHeader>
            <CardTitle>基础设置</CardTitle>
            <CardDescription>开关立即保存；超时单独保存。设置适用于所有对话。</CardDescription>
          </CardHeader>
          <CardContent className="ste:space-y-5">
            <SwitchField
              label="启用记忆插件"
              description="关闭后暂停同步和记忆宏；仍可在这里重新开启。"
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(value) =>
                void save(() => setSettingToggle(services, "enabled", value))
              }
            />
            <SwitchField
              label="同步到对话文件"
              description={`随对话文件保存记忆快照${settings.mirror.includeHistory ? "与修订历史" : ""}。插件关闭时暂停同步。`}
              checked={settings.mirror.enabled}
              disabled={busy}
              onCheckedChange={(value) =>
                void save(() => setSettingToggle(services, "mirror", value))
              }
            />
            <p role="status" className="ste:text-xs ste:text-muted-foreground">
              {mirror.kind === "failed"
                ? `对话文件同步失败：${mirror.error}`
                : mirror.kind === "saving"
                  ? "正在写入对话文件…"
                  : mirror.kind === "disabled"
                    ? "对话文件同步已暂停"
                    : mirror.lastWrittenAt
                      ? `最近写入：${new Date(mirror.lastWrittenAt).toLocaleString()}`
                      : "尚无对话文件写入记录"}
            </p>
            <form
              className="ste:space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && dirty) void save(() => saveFillTimeout(services, timeout), true);
              }}
            >
              <Field>
                <FieldLabel htmlFor="settings-fill-timeout">每批填写 Agent 超时（秒）</FieldLabel>
                <Input
                  id="settings-fill-timeout"
                  type="number"
                  min={30}
                  max={1800}
                  step={1}
                  required
                  value={timeout}
                  disabled={busy}
                  onChange={(event) => setTimeoutValue(event.target.value)}
                  aria-describedby="settings-fill-timeout-description"
                />
                <FieldDescription id="settings-fill-timeout-description">
                  30–1800 秒的整数，包含当前批次中的重试等待。
                </FieldDescription>
              </Field>
              <div className="ste:flex ste:items-center ste:justify-between ste:gap-3">
                <span className="ste:text-xs ste:text-muted-foreground">
                  {dirty ? "超时有未保存修改" : "超时已保存"}
                </span>
                <Button type="submit" size="sm" disabled={busy || !dirty}>
                  {busy ? "正在保存…" : "保存超时"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        {(
          [
            {
              label: "连接与填写",
              items: [
                ["connections", "Agent 连接与模型"],
                ["embedding", "Embedding 连接"],
                ["rerank", "重排设置"],
                ["auto-fill", "自动填表"],
              ],
            },
            {
              label: "预设与规则",
              items: [
                ["agent-presets", "Agent 提示词预设"],
                ["table-presets", "表格预设"],
                ["cleaning", "清洗规则"],
                ["macros", "记忆宏"],
              ],
            },
            {
              label: "工具与维护",
              items: [
                ["query", "记忆问答"],
                ["logs", "运行日志"],
                ["maintenance", "备份与空间维护"],
                ["sql", "SQL 控制台"],
              ],
            },
          ] as const
        ).map((group) => (
          <section key={group.label} className="ste:flex ste:flex-col ste:gap-2">
            <h2 className="ste:mt-2 ste:text-sm ste:font-semibold">{group.label}</h2>
            {group.items.map(([id, label]) => (
              <Button
                key={id}
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => requestLeave(() => onOpen(id))}
              >
                {label}
                <ChevronRight />
              </Button>
            ))}
          </section>
        ))}
        <Card size="sm">
          <CardHeader>
            <CardTitle>外观</CardTitle>
            <CardDescription>切换工作台的亮色或暗色外观。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={controls.onToggleTone}>
              切换亮暗色
            </Button>
          </CardContent>
        </Card>
      </PageContent>
      {confirmation}
    </div>
  );
}
