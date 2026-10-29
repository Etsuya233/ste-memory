import { useEffect, useRef, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import {
  presetUpdateChanges,
  type PresetUpdateNode,
  type PresetUpdateOutcome,
  type PresetUpdatePlan,
} from "../../../features/table-presets/preset-space-update.ts";
import {
  listTablePresets,
  type ResolvedTablePreset,
} from "../../../features/table-presets/preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "../../../features/table-presets/system-preset.ts";
import { serializeTablePresetExport } from "../../../features/table-presets/preset-transfer.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Checkbox } from "../../../ui/primitives/checkbox.tsx";
import { Field, FieldLabel, FieldGroup } from "../../../ui/primitives/field.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Card, CardHeader, CardTitle, CardContent } from "../../../ui/primitives/card.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogHeader,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "../../../ui/primitives/alert-dialog.tsx";
import { PageHeader, PageContent, PageFooter } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { usePageLeave } from "../../components/confirmation.tsx";
import type { SettingsSubpageProps } from "./connection-settings-editor.tsx";
import type { PresetContext, PresetSettingsServices } from "./preset-settings-services.ts";

export function PresetUpdatePage(
  props: SettingsSubpageProps & {
    presets: PresetSettingsServices;
    target: PresetContext;
    preset: ResolvedTablePreset;
  },
) {
  const { presets, target, preset } = props;
  const current = presets.currentContext();
  const key = JSON.stringify([current?.chatIdentity, current?.spaceId]);
  const targetKey = JSON.stringify([target.chatIdentity, target.spaceId]);
  const contextVersion = useRef({ key, value: 0 });
  if (contextVersion.current.key !== key)
    contextVersion.current = { key, value: contextVersion.current.value + 1 };
  const currentVersion = contextVersion.current.value;
  const active = key === targetKey;
  const operation = useRef(0);
  const running = useRef<"compare" | "apply" | "retry" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<{ version: number; plan: PresetUpdatePlan } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PresetUpdateOutcome | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const plan = active && loaded?.version === currentVersion ? loaded.plan : null;
  const result = active ? outcome : null;
  const changes = plan ? presetUpdateChanges(plan.nodes) : [];
  const chosen = changes.filter((change) => selected.has(change.id));
  const counts = { create: 0, update: 0, delete: 0 };
  for (const change of chosen) counts[change.action]++;
  const { requestLeave, confirmation } = usePageLeave({
    dirty: !!plan && selected.size > 0,
    busy,
    scope: `preset-update:${key}`,
    discard: () => {
      setSelected(new Set());
      setConfirming(false);
    },
    register: props.registerLeaveGuard,
  });
  useEffect(() => {
    if (running.current !== "apply" && running.current !== "retry") {
      operation.current++;
      running.current = null;
      setBusy(false);
    }
    setLoaded(null);
    setSelected(new Set());
    setConfirming(false);
    setError(null);
  }, [key]);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!busy && !(plan && selected.size)) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [busy, plan, selected.size]);

  function assertTarget() {
    const live = presets.currentContext();
    if (live?.chatIdentity !== target.chatIdentity || live.spaceId !== target.spaceId)
      throw new Error("目标对话已切换，请返回原对话后重新比较。");
  }
  function assertSnapshot() {
    assertTarget();
    const saved = listTablePresets(
      props.services.settings.read().tablePresets,
      SYSTEM_TABLE_PRESET,
    ).find((item) => item.id === preset.id);
    if (!saved || serializeTablePresetExport(saved, "") !== serializeTablePresetExport(preset, ""))
      throw new Error("来源预设已变化，请返回预设列表后重新打开比较。");
  }
  function isCurrent(token: number, version: number) {
    return token === operation.current && version === contextVersion.current.value;
  }
  async function compare() {
    if (running.current) return;
    const token = ++operation.current,
      version = currentVersion;
    running.current = "compare";
    setBusy(true);
    setError(null);
    setOutcome((current) => (current?.issues.length ? current : null));
    setLoaded(null);
    setSelected(new Set());
    try {
      assertSnapshot();
      const next = await presets.spaceUpdate.preview(
        target.spaceId,
        structuredClone(preset),
        target.chatIdentity,
      );
      if (!isCurrent(token, version)) return;
      assertSnapshot();
      setLoaded({ version, plan: next });
    } catch (cause) {
      if (isCurrent(token, version))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent(token, version)) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  async function execute(withBackup: boolean) {
    if (!plan || running.current) return;
    const captured = plan,
      ids = [...selected],
      token = ++operation.current,
      version = currentVersion;
    running.current = "apply";
    setBusy(true);
    setError(null);
    try {
      assertSnapshot();
      if (withBackup && !(await presets.backupCurrentSpace(target))) {
        if (isCurrent(token, version)) setError("备份未完成，未执行所选变更。");
        return;
      }
      if (!isCurrent(token, version)) return;
      assertSnapshot();
      const next = await presets.spaceUpdate.apply(captured, ids, target.chatIdentity);
      if (token !== operation.current) return;
      setLoaded(null);
      setSelected(new Set());
      setConfirming(false);
      setOutcome(next);
    } catch (cause) {
      if (token === operation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === operation.current) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  async function retrySave() {
    if (running.current) return;
    const token = ++operation.current;
    running.current = "retry";
    setBusy(true);
    setError(null);
    try {
      assertTarget();
      const next = await presets.spaceUpdate.retrySave(target.spaceId, target.chatIdentity);
      if (token === operation.current) setOutcome(next);
    } catch (cause) {
      if (token === operation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === operation.current) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  function toggle(ids: readonly string[], checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="预设增量更新"
        subtitle={target.title}
        icon={GitCompareArrows}
        {...props.controls}
        onBack={() => requestLeave(props.onBack)}
        busy={busy}
      />
      <PageContent className="ste:flex ste:flex-col ste:gap-5" data-page="preset-update">
        <PageSection
          title={preset.name}
          action={
            <Button
              size="sm"
              disabled={!active || busy}
              onClick={() => void compare()}
              data-action="compare-preset-update"
            >
              {busy ? "正在处理…" : plan ? "重新比较" : "比较变更"}
            </Button>
          }
        >
          <p className="ste:text-sm ste:text-muted-foreground">
            按表、字段和向量分组的 Key 比较，只执行勾选项。
          </p>
        </PageSection>
        {!active ? (
          <PageEmpty
            title="目标对话已切换"
            description="返回原对话后重新比较，之前的差异和确认已作废。"
          />
        ) : null}
        {active && error ? <StatusNotice variant="destructive">{error}</StatusNotice> : null}
        {result ? (
          <StatusNotice>
            <div className="ste:flex ste:flex-col ste:gap-3" data-testid="preset-update-result">
              <p>
                {result.issues.length
                  ? "所选变更已提交，以下同步步骤尚未完成："
                  : "所选变更已提交，保存和索引核对已完成。"}
              </p>
              {result.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
              {result.issues.length ? (
                <Button variant="outline" disabled={busy} onClick={() => void retrySave()}>
                  重试保存与索引核对
                </Button>
              ) : null}
            </div>
          </StatusNotice>
        ) : null}
        {active && !plan && !result ? (
          <PageEmpty
            title="尚未比较变更"
            description="比较当前空间与已保存预设，按需勾选要执行的差异。"
          />
        ) : null}
        {plan ? (
          <PageSection
            title="差异"
            action={
              <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
                <span className="ste:text-xs ste:text-muted-foreground">
                  {changes.length} 项变更
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !changes.some((change) => change.action === "update")}
                  onClick={() =>
                    toggle(
                      changes
                        .filter((change) => change.action === "update")
                        .map((change) => change.id),
                      true,
                    )
                  }
                >
                  选择全部更新
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !changes.some((change) => change.action === "create")}
                  onClick={() =>
                    toggle(
                      changes
                        .filter((change) => change.action === "create")
                        .map((change) => change.id),
                      true,
                    )
                  }
                >
                  选择全部新增
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !selected.size}
                  onClick={() => setSelected(new Set())}
                >
                  清空选择
                </Button>
              </div>
            }
          >
            <div className="ste:flex ste:flex-col ste:gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="preset-update-filter">差异筛选</FieldLabel>
                  <NativeSelect
                    id="preset-update-filter"
                    value={filter}
                    disabled={busy}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">全部差异</option>
                    <option value="selected">仅已选项</option>
                  </NativeSelect>
                </Field>
              </FieldGroup>
              <p className="ste:text-xs ste:text-muted-foreground">修改 Key 会产生新增与删除。</p>
              {!changes.length && plan.nodes.length ? (
                <PageEmpty
                  title="没有可执行的变更"
                  description="仅存在保留当前值的差异，已有字段类型保持原样。"
                />
              ) : null}
              {plan.nodes.length ? (
                <div className="ste:flex ste:flex-col ste:gap-3" aria-label="空间变更树">
                  {plan.nodes.map((node) => (
                    <UpdateNode
                      key={node.id}
                      node={node}
                      selected={selected}
                      disabled={busy}
                      selectedOnly={filter === "selected"}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              ) : (
                <PageEmpty title="没有可更新的差异" description="当前空间与这份已保存预设一致。" />
              )}
              {filter === "selected" && !chosen.length && plan.nodes.length ? (
                <PageEmpty title="尚未选择变更" description="切回全部差异后勾选要执行的内容。" />
              ) : null}
            </div>
          </PageSection>
        ) : null}
      </PageContent>
      {plan && changes.length ? (
        <PageFooter className="ste:flex-col ste:items-stretch ste:sm:flex-row ste:sm:items-center">
          <p className="ste:text-xs ste:text-muted-foreground">
            已选：新增 {counts.create} 项 · 更新 {counts.update} 项 · 删除 {counts.delete} 项
          </p>
          <Button
            variant={counts.delete ? "destructive" : "default"}
            disabled={busy || !chosen.length}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            data-action="confirm-preset-update"
          >
            执行所选变更
          </Button>
        </PageFooter>
      ) : null}
      {confirmation}
      <AlertDialog
        open={confirming && !!plan}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogTitle>更新「{target.title}」</AlertDialogTitle>
            <AlertDialogDescription>
              将新增 {counts.create} 项、更新 {counts.update} 项、删除 {counts.delete}{" "}
              项。只执行本次勾选的变更。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="ste:flex ste:max-h-[45dvh] ste:flex-col ste:gap-3 ste:overflow-y-auto ste:text-sm">
            {chosen
              .filter((change) => change.action === "delete")
              .map((change) => (
                <p key={change.id} className="ste:break-words">
                  删除：{change.tableKey}
                  {change.fieldKey
                    ? ` / 字段 ${change.fieldKey}`
                    : change.groupKey
                      ? ` / 分组 ${change.groupKey}`
                      : "（含整表记录与历史）"}
                </p>
              ))}
            <p>
              执行会停止此空间运行和排队中的填表任务，已提交批次与历史保留。失败后已停止的任务不会自动恢复。
            </p>
            <p>
              向量输入变化后，旧索引停止参与检索；自动模式会在后台补建，可能产生 Embedding
              请求费用。
            </p>
            {error ? <StatusNotice variant="destructive">{error}</StatusNotice> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancel} disabled={busy}>
              取消
            </AlertDialogCancel>
            <Button
              variant={counts.delete ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => void execute(false)}
            >
              直接执行
            </Button>
            <Button disabled={busy} onClick={() => void execute(true)}>
              备份并执行
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UpdateNode(props: {
  node: PresetUpdateNode;
  selected: ReadonlySet<string>;
  disabled: boolean;
  selectedOnly: boolean;
  onToggle: (ids: readonly string[], checked: boolean) => void;
}) {
  const { node, selected } = props;
  const ids = presetUpdateChanges([node]).map((change) => change.id);
  const count = ids.filter((id) => selected.has(id)).length;
  if (props.selectedOnly && !count) return null;
  return (
    <Card size="sm" data-change-action={node.change?.action}>
      <CardHeader>
        <div className="ste:flex ste:items-start ste:gap-3">
          <Checkbox
            aria-label={`选择 ${node.label}`}
            checked={!!ids.length && count === ids.length}
            indeterminate={count > 0 && count < ids.length}
            disabled={props.disabled || !ids.length}
            onCheckedChange={(checked) => props.onToggle(ids, !!checked)}
          />
          <div className="ste:flex ste:min-w-0 ste:flex-1 ste:flex-col ste:gap-2">
            <CardTitle className="ste:break-words">{node.label}</CardTitle>
            {node.change ? (
              <Badge variant={node.change.action === "delete" ? "destructive" : "secondary"}>
                {{ create: "新增", update: "更新", delete: "删除" }[node.change.action]}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
        {node.note ? <p className="ste:text-xs ste:text-muted-foreground">{node.note}</p> : null}
        {node.change && node.change.action !== "delete" ? (
          <Accordion>
            <AccordionItem>
              <AccordionTrigger>
                {node.change.action === "create" ? "查看新增定义" : "查看差异"}
              </AccordionTrigger>
              <AccordionContent>
                <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
                  {node.change.action === "update" ? (
                    <div>
                      <p className="ste:mb-2 ste:text-xs ste:text-muted-foreground">空间当前值</p>
                      <pre className="ste:max-h-60 ste:overflow-auto ste:rounded-lg ste:bg-muted ste:p-3 ste:text-xs ste:break-words ste:whitespace-pre-wrap">
                        {formatValue(node.change.before)}
                      </pre>
                    </div>
                  ) : null}
                  <div>
                    <p className="ste:mb-2 ste:text-xs ste:text-muted-foreground">预设值</p>
                    <pre className="ste:max-h-60 ste:overflow-auto ste:rounded-lg ste:bg-muted ste:p-3 ste:text-xs ste:break-words ste:whitespace-pre-wrap">
                      {formatValue(node.change.after)}
                    </pre>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : null}
        {node.children.length ? (
          <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
            {node.children.map((child) => (
              <UpdateNode {...props} key={child.id} node={child} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatValue(value: unknown): string {
  if (value === "") return "（空，选择更新将清空）";
  if (value === undefined || value === null) return "（无）";
  if (typeof value === "boolean") return value ? "启用" : "停用";
  if (value === "manual") return "手动";
  if (value === "automatic") return "自动";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
