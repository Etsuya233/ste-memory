import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import type { ChatMirrorStatus } from "../../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import {
  SYSTEM_TABLE_PRESET_ID,
  SYSTEM_TABLE_PRESET_NAME,
} from "../../../features/table-presets/preset-model.ts";
import { STORY_MEMORY_PRESET } from "../../../features/table-presets/story-memory-preset.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../../ui/primitives/card.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import {
  saveFillTimeout,
  setSettingToggle,
  type SettingsSaveResult,
  type SettingsServices,
} from "./settings-actions.ts";

export type { SettingsServices } from "./settings-actions.ts";

export function SettingsPage({
  services,
  controls,
  registerLeaveGuard,
  mirror,
}: {
  services: SettingsServices;
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
  mirror: ChatMirrorStatus;
}) {
  const [settings, setSettings] = useState(() => services.settings.read());
  const [timeout, setTimeoutValue] = useState(() => String(settings.fillAgentTimeoutSeconds));
  const [savedTimeout, setSavedTimeout] = useState(timeout);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dirty = timeout !== savedTimeout;
  const { confirmation } = usePageLeave({
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

  const connectionSummary = (id: string | undefined) => {
    if (id === undefined) return "跟随 SillyTavern 当前连接";
    const connection = settings.agentConnections.find((item) => item.id === id);
    return connection ? `${connection.name} · ${connection.model}` : "所选连接已不存在";
  };
  const agentPreset = settings.agentPresets.presets.find(
    (item) => item.id === settings.agentPresets.activePresetId,
  );
  const tablePreset = settings.tablePresets.userPresets.find(
    (item) => item.id === settings.tablePresets.defaultPresetId,
  );
  const tablePresetName =
    settings.tablePresets.defaultPresetId === SYSTEM_TABLE_PRESET_ID
      ? SYSTEM_TABLE_PRESET_NAME
      : settings.tablePresets.defaultPresetId === STORY_MEMORY_PRESET.id
        ? STORY_MEMORY_PRESET.name
        : (tablePreset?.name ?? "所选预设已不存在");
  const summaries = [
    {
      title: "Agent 连接与模型",
      summary: `${settings.agentConnections.length} 个独立连接`,
      details: [
        `表格填写 Agent：${connectionSummary(settings.fillTaskConnectionId)}`,
        `查询 Agent：${connectionSummary(settings.queryChatConnectionId)}`,
      ],
    },
    {
      title: "Embedding 与重排",
      summary: `向量连接${settings.embeddingConnection ? "已配置" : "未配置"} · 重排${settings.rerank.enabled ? "已开启" : "已关闭"}`,
      details: [
        `Embedding 模型：${settings.embeddingConnection?.model ?? "未配置"}`,
        `重排模型：${settings.rerank.connection?.model ?? "未配置"}`,
        `重排候选数：${settings.rerank.candidateLimit}`,
      ],
    },
    {
      title: "Agent 提示词预设",
      summary: `活动预设：${agentPreset?.name ?? "系统默认"}`,
      details: [
        `自定义预设：${settings.agentPresets.presets.length} 份`,
        `活动预设消息：${agentPreset ? agentPreset.messages.length : "使用系统内置提示词"}`,
      ],
    },
    {
      title: "表格预设",
      summary: `新空间默认：${tablePresetName}`,
      details: [
        `用户预设：${settings.tablePresets.userPresets.length} 份`,
        "默认预设用于之后创建的记忆空间。",
      ],
    },
    {
      title: "清洗规则",
      summary: `${settings.cleaningRules.length} 份规则 · ${settings.cleaningRules.filter((item) => item.enabled).length} 份启用`,
      details: ["每个对话独立选择清洗规则，只影响填表输入中的 AI 输出消息。"],
    },
    {
      title: "记忆宏",
      summary: `${settings.macros.length} 个全局宏 · ${settings.macros.filter((item) => item.enabled).length} 个启用`,
      details: [
        `全局前缀：${settings.macroName}`,
        `输出上限：${settings.macroLimit} 字符`,
        "对话宏随各自绑定的记忆空间保存。",
      ],
    },
  ];

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="设置"
        subtitle={`全局设置 · v${services.version}`}
        icon={Settings}
        {...controls}
        busy={busy}
      />
      <PageContent className="ste:space-y-4">
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
        <div className="ste:space-y-2">
          <p className="ste:text-sm ste:text-muted-foreground">
            以下展示已保存配置，当前页面暂不支持编辑。
          </p>
          <Accordion>
            {summaries.map((group) => (
              <AccordionItem key={group.title}>
                <AccordionTrigger>
                  <span className="ste:min-w-0 ste:break-words">
                    <span className="ste:block">{group.title}</span>
                    <span className="ste:mt-1 ste:block ste:text-xs ste:font-normal ste:text-muted-foreground">
                      {group.summary}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="ste:space-y-2 ste:break-words">
                    {group.details.map((detail) => (
                      <p key={detail}>{detail}</p>
                    ))}
                    <p className="ste:text-xs ste:text-muted-foreground">只读摘要 · 暂不可编辑</p>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </PageContent>
      {confirmation}
    </div>
  );
}
