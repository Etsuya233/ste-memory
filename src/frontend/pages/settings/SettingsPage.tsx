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
import type { QueryServices } from "../query/query-page.tsx";
import { SearchPage, type SearchServices, type SearchPageProps } from "../search/search-page.tsx";
import { SqlPage, type SqlServices } from "../sql/sql-page.tsx";
import type { LogRepository } from "../../../features/logging/log.ts";
import {
  isEntryPlacement,
  type PluginSettings,
} from "../../../features/settings/plugin-settings.ts";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { NativeSelect, NativeSelectOption } from "../../primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../primitives/field.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../primitives/item.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
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
  | "search"
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
  search: SearchServices;
  onSearchRecord: SearchPageProps["onRecord"];
  onSearchIndex: SearchPageProps["onIndex"];
  active: boolean;
};

const settingGroups = [
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
      ["logs", "运行日志"],
      ["search", "向量搜索"],
      ["maintenance", "备份与空间维护"],
      ["sql", "SQL 控制台"],
    ],
  },
] as const;

function buildEntrySummaries(
  settings: PluginSettings,
  context: RecordsContext | null,
): Partial<Record<SettingsSection, string>> {
  const fillConnection = settings.agentConnections.find(
    (connection) => connection.id === settings.fillTaskConnectionId,
  );
  const activePreset = settings.agentPresets.presets.find(
    (preset) => preset.id === settings.agentPresets.activePresetId,
  );
  const defaultTablePreset = settings.tablePresets.userPresets.find(
    (preset) => preset.id === settings.tablePresets.defaultPresetId,
  );
  return {
    connections: settings.agentConnections.length
      ? `${settings.agentConnections.length} 个连接 · ${fillConnection?.name ?? "填表跟随 ST"}`
      : "跟随 ST 当前连接",
    embedding: settings.embeddingConnection
      ? `已配置 · ${settings.embeddingConnection.model}`
      : "未配置",
    rerank: settings.rerank.enabled
      ? `已启用 · ${settings.rerank.connection?.model ?? "无连接"}`
      : "已关闭",
    "auto-fill":
      settings.autoFill.mode === "auto"
        ? `自动 · 每 ${settings.autoFill.interval} 层`
        : settings.autoFill.mode === "remind"
          ? "仅提醒"
          : "已关闭",
    "agent-presets": settings.agentPresets.presets.length
      ? `${settings.agentPresets.presets.length} 个自定义 · ${activePreset?.name ?? "系统默认"}`
      : "系统默认",
    "table-presets": settings.tablePresets.userPresets.length
      ? `${settings.tablePresets.userPresets.length} 个自定义 · ${defaultTablePreset?.name ?? "系统预设"}`
      : "系统预设",
    cleaning: `${settings.cleaningRules.length} 条全局规则`,
    macros: `${settings.macros.length} 个全局宏`,
    logs: "运行记录与错误",
    search: context ? "查询当前记忆空间的向量索引" : "打开对话后可用",
    maintenance: "备份 · 恢复 · 清理",
    sql: context ? "当前记忆空间" : "打开对话后可用",
  };
}

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
  if (section === "search")
    return (
      <SearchPage
        {...props.search}
        context={props.context}
        controls={props.controls}
        onBack={detailProps.onBack}
        active={props.active}
        connection={props.services.settings.read().embeddingConnection}
        onRecord={props.onSearchRecord}
        onIndex={props.onSearchIndex}
        onSettings={() => setSection("embedding")}
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
  context,
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

  const summaries = buildEntrySummaries(settings, context);

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="设置"
        subtitle={`全局设置 · v${services.version}`}
        icon={Settings}
        {...controls}
        busy={busy}
      />
      <div
        className="ste:shrink-0 ste:border-b ste:border-border ste:px-4 ste:py-2 ste:text-xs ste:break-words ste:text-muted-foreground"
        aria-live="polite"
      >
        {mirror.kind === "failed" ? (
          <span className="ste:text-destructive">对话文件同步失败：{mirror.error}</span>
        ) : mirror.kind === "saving" ? (
          "正在写入对话文件…"
        ) : mirror.kind === "disabled" ? (
          "对话文件同步已暂停"
        ) : mirror.lastWrittenAt ? (
          `最近写入：${new Date(mirror.lastWrittenAt).toLocaleString()}`
        ) : (
          "尚未写入对话文件"
        )}
      </div>
      <PageContent ref={scroll.ref} onScroll={scroll.onScroll} className="ste:space-y-4">
        {notice ? (
          <StatusNotice variant={notice.error ? "destructive" : "default"}>
            {notice.text}
          </StatusNotice>
        ) : null}
        <PageSection
          title="基础设置"
          meta={<span className="ste:text-xs ste:text-muted-foreground">全局生效</span>}
        >
          <div className="ste:flex ste:flex-col ste:gap-5">
            <Field>
              <FieldLabel htmlFor="settings-entry-placement">入口位置</FieldLabel>
              <NativeSelect
                id="settings-entry-placement"
                value={settings.entryPlacement}
                disabled={busy}
                aria-describedby="settings-entry-placement-description"
                onChange={(event) => {
                  const placement = event.target.value;
                  if (!isEntryPlacement(placement)) throw new Error("无效的入口位置");
                  void save(async () => {
                    services.settings.setEntryPlacement(placement);
                    await services.onChanged();
                    return { settings: services.settings.read(), saved: true };
                  });
                }}
              >
                <NativeSelectOption value="top">顶栏</NativeSelectOption>
                <NativeSelectOption value="wand">魔法棒</NativeSelectOption>
                <NativeSelectOption value="both">顶栏和魔法棒</NativeSelectOption>
              </NativeSelect>
              <FieldDescription id="settings-entry-placement-description">
                选择记忆工作台的入口，修改后立即保存并生效。
              </FieldDescription>
            </Field>
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
          </div>
        </PageSection>
        {settingGroups.map((group) => (
          <PageSection
            key={group.label}
            title={group.label}
            meta={
              <span className="ste:text-xs ste:text-muted-foreground">{group.items.length} 项</span>
            }
            bodyClassName="ste:p-0"
          >
            <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
              {group.items.map(([id, label]) => {
                const description = summaries[id];
                return (
                  <div role="listitem" key={id}>
                    <Item
                      render={<button type="button" />}
                      className="ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                      aria-label={label}
                      data-action={`open-settings-${id}`}
                      onClick={() => requestLeave(() => onOpen(id))}
                    >
                      <ItemContent>
                        <ItemTitle>{label}</ItemTitle>
                        {description ? (
                          <ItemDescription className="ste:line-clamp-1">
                            {description}
                          </ItemDescription>
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  </div>
                );
              })}
            </ItemGroup>
          </PageSection>
        ))}
      </PageContent>
      {confirmation}
    </div>
  );
}
