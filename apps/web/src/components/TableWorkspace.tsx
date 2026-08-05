import {
  Columns3,
  Database,
  Eraser,
  Play,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MemorySpace } from "../api/memory-spaces.ts";
import type { MemoryTable, MemoryTablePatch } from "../api/memory-tables.ts";
import { CleaningRulesPanel } from "./CleaningRulesPanel.tsx";
import { FieldEditor } from "./FieldEditor.tsx";
import { FillTaskPanel } from "./FillTaskPanel.tsx";
import { RecordTable, type RecordSelection } from "./RecordTable.tsx";
import { Badge, Button, Field, IconButton, Switch, TextArea, TextInput } from "../ui.tsx";

interface TableWorkspaceProps {
  readonly table?: MemoryTable;
  readonly tables: readonly MemoryTable[];
  readonly space?: MemorySpace;
  readonly memorySpaceId?: string;
  readonly onDelete: (table: MemoryTable) => void;
  readonly onSave: (table: MemoryTable, patch: MemoryTablePatch) => Promise<void>;
  readonly onTableUpdated: (table: MemoryTable) => void;
  readonly onSelectRecord: (selection: RecordSelection | undefined) => void;
  readonly recordRefreshVersion: number;
  /** 清洗规则保存后通知外层刷新原始消息展示。 */
  readonly onCleaningSaved: () => void;
}

type CenterTab = "data" | "fields" | "tasks" | "cleaning";

const TAB_DEFS: readonly { value: CenterTab; label: string; icon: typeof Database }[] = [
  { value: "data", label: "数据查看", icon: Database },
  { value: "fields", label: "字段配置", icon: Settings2 },
  { value: "tasks", label: "填表任务", icon: Play },
  { value: "cleaning", label: "清洗规则", icon: Eraser },
];

/**
 * 中央工作台：所选表格的数据 / 字段配置，以及所选空间的填表任务与清洗规则。
 * 四个面板常驻挂载（隐藏而非卸载），切换标签不丢状态、不中断轮询。
 */
export function TableWorkspace({
  table,
  tables,
  space,
  memorySpaceId,
  onDelete,
  onSave,
  onTableUpdated,
  onSelectRecord,
  recordRefreshVersion,
  onCleaningSaved,
}: TableWorkspaceProps) {
  const [tab, setTab] = useState<CenterTab>("data");
  const [tableKey, setTableKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setTableKey(table?.key ?? "");
    setName(table?.name ?? "");
    setDescription(table?.description ?? "");
    setPrompt(table?.prompt ?? "");
    setEnabled(table?.enabled ?? true);
    setError(undefined);
  }, [table]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!table) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(table, { key: tableKey, name, description, prompt, enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存表格配置");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="table-workspace">
      <header className="table-workspace-header">
        <div className="table-workspace-title">
          {table ? (
            <span className="table-breadcrumb">
              {space?.name ?? "记忆空间"} / {table.key}
            </span>
          ) : null}
          <div className="table-title-row">
            <h2>{table?.name ?? "记忆工作台"}</h2>
            {table ? (
              <Badge tone={table.enabled ? "accent" : "warn"}>
                {table.enabled ? "已启用" : "已停用"}
              </Badge>
            ) : null}
            {table?.kind === "system" ? <Badge>系统表</Badge> : null}
          </div>
          <p>{table?.description || (space ? `正在查看「${space.name}」的记忆内容` : "选择左侧的记忆空间开始工作")}</p>
        </div>
        {table ? (
          <IconButton
            label={`删除表格 ${table.name}`}
            danger
           
            onClick={() => onDelete(table)}
          >
            <Trash2 size={16} />
          </IconButton>
        ) : null}
      </header>

      <nav className="table-tabs" aria-label="工作台视图">
        {TAB_DEFS.map((def) => {
          const Icon = def.icon;
          return (
            <button
              key={def.value}
              className={tab === def.value ? "active" : ""}
              type="button"
              onClick={() => setTab(def.value)}
            >
              <Icon size={14} />
              {def.label}
              {def.value === "tasks" && space?.messageCount ? (
                <span className="table-tab-badge">{space.messageCount}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* 数据查看 */}
      <div className={tab === "data" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
        {!table ? (
          <div className="empty-state workspace-empty">
            <Columns3 size={34} />
            <strong>选择一张记忆表格</strong>
            <p>表格的数据、字段配置、填表任务与清洗规则都汇总在这里。</p>
          </div>
        ) : memorySpaceId ? (
          <RecordTable
            key={table.id}
            memorySpaceId={memorySpaceId}
            table={table}
            onSelect={onSelectRecord}
            refreshVersion={recordRefreshVersion}
          />
        ) : null}
      </div>

      {/* 字段配置 */}
      <div className={tab === "fields" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
        {!table ? (
          <div className="empty-state workspace-empty">
            <Settings2 size={34} />
            <strong>暂无表格配置</strong>
            <p>创建或选择一张表格后，在这里配置字段与显示策略。</p>
          </div>
        ) : (
          <div className="table-definition-workspace">
            <form className="table-config-form" onSubmit={(event) => void save(event)}>
              <div className="config-heading">
                <div>
                  <h3>表格配置</h3>
                  <p>这些设置只影响当前记忆空间。</p>
                </div>
                <Button variant="primary" type="submit" icon={<Save size={14} />} loading={busy}>
                  保存
                </Button>
              </div>
              <div className="form-grid">
                <Field label="表格 Key" htmlFor="table-key" required>
                  <TextInput
                    id="table-key"
                    required
                    maxLength={120}
                    value={tableKey}
                    onChange={(event) => setTableKey(event.target.value)}
                  />
                </Field>
                <Field label="表格名称" htmlFor="table-name" required>
                  <TextInput
                    id="table-name"
                    required
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              </div>
              <Field label="描述" htmlFor="table-desc" className="config-field-gap">
                <TextArea
                  id="table-desc"
                  rows={2}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field
                label="表级 Prompt"
                htmlFor="table-prompt"
                className="config-field-gap"
                hint="Agent 填表时的指令上下文"
              >
                <TextArea
                  id="table-prompt"
                  rows={7}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </Field>
              <div className="config-checkbox config-field-gap">
                <Switch
                  id="table-enabled"
                  checked={enabled}
                  onChange={setEnabled}
                  label="参与 Agent 自动填写"
                  hint={enabled ? "Agent 会把该表纳入填表流程" : "Agent 填表时跳过该表"}
                />
              </div>
              {error ? <p className="form-error">{error}</p> : null}
            </form>
            {memorySpaceId ? (
              <FieldEditor
                key={table.id}
                memorySpaceId={memorySpaceId}
                table={table}
                tables={tables}
                onTableUpdated={onTableUpdated}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* 填表任务 */}
      <div className={tab === "tasks" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
        {space ? (
          <FillTaskPanel space={space} />
        ) : (
          <div className="empty-state workspace-empty">
            <Play size={34} />
            <strong>请先选择记忆空间</strong>
            <p>选择空间后，可以在这里提交后台填表任务。</p>
          </div>
        )}
      </div>

      {/* 清洗规则 */}
      <div className={tab === "cleaning" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
        {space ? (
          <CleaningRulesPanel spaceId={space.id} onSaved={onCleaningSaved} />
        ) : (
          <div className="empty-state workspace-empty">
            <Eraser size={34} />
            <strong>请先选择记忆空间</strong>
            <p>选择空间后，可以在这里配置消息清洗规则。</p>
          </div>
        )}
      </div>
    </section>
  );
}
