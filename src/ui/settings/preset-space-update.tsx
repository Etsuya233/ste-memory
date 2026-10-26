import { useEffect, useRef, useState } from "react";
import { Button, Select } from "../kit/controls.tsx";
import { Dialog } from "../kit/dialog.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import {
  presetUpdateChanges,
  type PresetSpaceUpdateService,
  type PresetUpdateNode,
  type PresetUpdatePlan,
} from "../../features/table-presets/preset-space-update.ts";
import type { ResolvedTablePreset } from "../../features/table-presets/preset-model.ts";

export function PresetSpaceUpdate(props: {
  readonly spaceId: PresetUpdatePlan["spaceId"];
  readonly chatIdentity: string;
  readonly sourcePresetId?: string;
  readonly presets: readonly ResolvedTablePreset[];
  readonly service: PresetSpaceUpdateService;
  readonly onBackup: () => Promise<boolean>;
  readonly onBack: () => void;
  readonly onDataChanged: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const [presetId, setPresetId] = useState(
    props.presets.some((preset) => preset.id === props.sourcePresetId) ? props.sourcePresetId! : "",
  );
  const [plan, setPlan] = useState<PresetUpdatePlan | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "selected">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ issues: readonly string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const running = useRef(false);
  const dirty = useRef(false);
  dirty.current = busy || selected.size > 0;
  const preset = props.presets.find((item) => item.id === presetId);
  const changes = plan ? presetUpdateChanges(plan.nodes) : [];
  const chosen = changes.filter((change) => selected.has(change.id));
  const counts = { create: 0, update: 0, delete: 0 };
  for (const change of chosen) counts[change.action]++;

  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !dirty.current || window.confirm("有尚未执行的更新选择，放弃并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);

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

  async function compare() {
    if (!preset || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setPlan(null);
    setSelected(new Set());
    try {
      setPlan(await props.service.preview(props.spaceId, preset, props.chatIdentity));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function execute(backup: boolean) {
    if (!plan || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (backup && !(await props.onBackup())) {
        setError("备份未完成，未执行更新");
        return;
      }
      const outcome = await props.service.apply(plan, [...selected], props.chatIdentity);
      setResult(outcome);
      setPlan(null);
      setSelected(new Set());
      setConfirming(false);
      props.onDataChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function retrySave() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      setResult(await props.service.retrySave(props.spaceId, props.chatIdentity));
      props.onDataChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="stm-settings-detail-page stm-preset-update"
      data-stm-section="preset-space-update"
    >
      <PageChrome
        pageKey="preset-space-update"
        header={
          <PanelBar
            title="从预设更新空间"
            leading={
              <PanelBarAction
                icon="fa-arrow-left"
                label="返回预设列表"
                disabled={busy}
                onClick={() => {
                  if (!dirty.current || window.confirm("放弃尚未执行的更新选择并返回吗？"))
                    props.onBack();
                }}
              />
            }
          />
        }
        footer={
          plan ? (
            <div className="stm-preset-update-footer">
              <span>
                已选：新增 {counts.create} 项，更新 {counts.update} 项，删除 {counts.delete} 项
              </span>
              <Button
                variant={counts.delete ? "danger" : "primary"}
                disabled={busy || !chosen.length}
                onClick={() => {
                  setError("");
                  setConfirming(true);
                }}
              >
                执行所选变更
              </Button>
            </div>
          ) : undefined
        }
      />
      <p className="stm-setting-hint">
        按表 Key、字段 Key、向量分组 Key 比较。只执行勾选项，已有字段类型保持不变。
      </p>
      <div className="stm-preset-row">
        <Select
          aria-label="更新来源预设"
          value={presetId}
          disabled={busy}
          onChange={(event) => {
            setPresetId(event.target.value);
            setPlan(null);
            setSelected(new Set());
            setError("");
            setResult(null);
          }}
        >
          <option value="">选择表格预设</option>
          {props.presets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button disabled={busy || !preset} onClick={() => void compare()}>
          {busy ? "处理中…" : "比较变更"}
        </Button>
      </div>
      {error && (
        <p className="stm-form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="stm-preset-update-result">
          <p>
            空间已更新。
            {result.issues.length
              ? "以下步骤尚未完成："
              : "已完成保存和索引核对；自动索引将在后台补建。"}
          </p>
          {result.issues.map((issue) => (
            <p className="stm-form-error" key={issue}>
              {issue}
            </p>
          ))}
          {result.issues.length > 0 && (
            <Button disabled={busy} onClick={() => void retrySave()}>
              重试保存与索引核对
            </Button>
          )}
        </div>
      )}
      {plan && (
        <>
          <p className="stm-setting-hint">
            目标空间：{plan.spaceName}；预设：{plan.preset.name}。修改 Key
            会显示为新增和删除。其他对话中的宏与召回配置不在本次检查范围内。
          </p>
          <div className="stm-preset-update-toolbar">
            <Button
              disabled={busy}
              onClick={() =>
                toggle(
                  changes.filter((item) => item.action === "update").map((item) => item.id),
                  true,
                )
              }
            >
              选择全部更新
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                toggle(
                  changes.filter((item) => item.action === "create").map((item) => item.id),
                  true,
                )
              }
            >
              选择全部新增
            </Button>
            <Button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>
              清空选择
            </Button>
            <Select
              aria-label="差异筛选"
              value={filter}
              onChange={(event) => setFilter(event.target.value as typeof filter)}
            >
              <option value="all">全部差异</option>
              <option value="selected">仅已选项</option>
            </Select>
          </div>
          {plan.nodes.length === 0 ? (
            <p>没有可更新的差异。</p>
          ) : (
            <ul className="stm-preset-update-tree" aria-label="空间变更树">
              {plan.nodes.map((node) => (
                <UpdateTreeNode
                  key={node.id}
                  node={node}
                  selected={selected}
                  disabled={busy}
                  selectedOnly={filter === "selected"}
                  onToggle={toggle}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {confirming && plan && (
        <Dialog
          label="确认更新空间"
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
          contentClassName="stm-modal"
        >
          <div className="stm-modal-title">更新「{plan.spaceName}」</div>
          <div className="stm-modal-body">
            <p>
              将新增 {counts.create} 项、更新 {counts.update} 项、删除 {counts.delete} 项。
            </p>
            {chosen
              .filter((item) => item.action === "delete")
              .map((change) => (
                <p className="stm-form-error" key={change.id}>
                  删除：{change.tableKey}
                  {change.fieldKey
                    ? ` / 字段 ${change.fieldKey}`
                    : change.groupKey
                      ? ` / 分组 ${change.groupKey}`
                      : "（包含整表记录和历史）"}
                </p>
              ))}
            <p>
              执行会停止此空间正在运行和排队的填表任务；已提交批次和任务历史保留。执行失败也不会自动恢复已停止任务。
            </p>
            <p>
              向量输入变化后旧索引停止参与检索；自动模式后台补建，手动模式需自行补建。自动模式可能产生
              embedding 请求费用。
            </p>
            {error && (
              <p role="alert" className="stm-form-error">
                {error}
              </p>
            )}
          </div>
          <div className="stm-modal-actions">
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void execute(true)}>
              备份并执行
            </Button>
            <Button
              disabled={busy}
              variant={counts.delete ? "danger" : "primary"}
              onClick={() => void execute(false)}
            >
              直接执行
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function UpdateTreeNode(props: {
  readonly node: PresetUpdateNode;
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly selectedOnly: boolean;
  readonly onToggle: (ids: readonly string[], checked: boolean) => void;
}) {
  const { node } = props;
  const ids = presetUpdateChanges([node]).map((change) => change.id);
  const count = ids.filter((id) => props.selected.has(id)).length;
  const partial = count > 0 && count < ids.length;
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = partial;
  }, [partial]);
  if (props.selectedOnly && count === 0) return null;
  return (
    <li className="stm-preset-update-node" data-action={node.change?.action}>
      <div className="stm-preset-update-node-head">
        <input
          ref={checkbox}
          type="checkbox"
          aria-label={`选择 ${node.label}`}
          aria-checked={partial ? "mixed" : count === ids.length && ids.length > 0}
          checked={ids.length > 0 && count === ids.length}
          disabled={props.disabled || !ids.length}
          onChange={(event) => props.onToggle(ids, event.target.checked)}
        />
        <span>{node.label}</span>
        {node.change && (
          <span className="stm-preset-update-badge">
            {{ create: "新增", update: "更新", delete: "删除" }[node.change.action]}
          </span>
        )}
      </div>
      {node.note && <p className="stm-setting-hint">{node.note}</p>}
      {node.change?.action === "create" && (
        <details className="stm-preset-update-diff">
          <summary>查看新增定义</summary>
          <pre>{formatValue(node.change.after)}</pre>
        </details>
      )}
      {node.change && node.change.action === "update" && (
        <details className="stm-preset-update-diff">
          <summary>查看差异</summary>
          <div className="stm-preset-update-values">
            <div>
              <strong>空间当前值</strong>
              <pre>{formatValue(node.change.before)}</pre>
            </div>
            <div>
              <strong>预设值</strong>
              <pre>{formatValue(node.change.after)}</pre>
            </div>
          </div>
        </details>
      )}
      {node.children.length > 0 && (
        <details open>
          <summary>展开子项（{ids.length} 项）</summary>
          <ul>
            {node.children.map((child) => (
              <UpdateTreeNode {...props} key={child.id} node={child} />
            ))}
          </ul>
        </details>
      )}
    </li>
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
