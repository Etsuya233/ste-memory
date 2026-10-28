import { SchemaEditorFields } from "../../components/schema-editor-fields.tsx";
import type { ResolvedTablePreset } from "../../../features/table-presets/preset-model.ts";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus, Table2, Trash2 } from "lucide-react";
import type { MemoryFieldId } from "../../../features/memory/index.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { usePrimitivesActive } from "../../../ui/primitives/provider.tsx";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../../ui/primitives/item.tsx";
import {
  PageHeader,
  PageContent,
  SaveActions,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";
import { displayStrategySummary } from "../../../ui/memory/display-strategy-model.ts";
import type { TablesWorkspace } from "./tables-workspace.ts";
import { VectorPreviewContent } from "./vector-preview-content.tsx";

export function TablesPage({
  workspace,
  controls,
  registerLeaveGuard,
  presets = [],
}: {
  workspace: TablesWorkspace;
  presets?: readonly ResolvedTablePreset[];
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const active = usePrimitivesActive();
  useLayoutEffect(() => {
    if (!active) return;
    const preview = workspace.getSnapshot().vectorPreview;
    if (preview?.record) void workspace.selectVectorRecord(preview.record.id);
    else if (preview) void workspace.loadVectorRecords(preview.page);
  }, [workspace, active]);
  const contextKey = [state.context?.chatKey, state.context?.spaceId];
  const viewKey = JSON.stringify([
    ...contextKey,
    state.tableId,
    state.editor?.kind ?? null,
    state.editor?.kind === "field" ? state.editor.original?.id : null,
    ...(state.vectorPreview
      ? [
          "vector-preview",
          state.vectorPreview.record?.id ?? null,
          state.vectorPreview.page,
          state.vectorPreview.search,
        ]
      : []),
  ]);
  const scroll = usePageScroll(
    workspace,
    viewKey,
    active && !state.loading && !state.vectorPreview?.loading,
    !state.editor || state.editor.kind === "vector" || !!state.vectorPreview,
  );
  const [deletion, setDeletion] = useState<{
    kind: "table" | "field" | "vectors";
    fieldId?: MemoryFieldId;
    name: string;
  } | null>(null);
  useEffect(() => setDeletion(null), [state.context?.chatKey, state.context?.spaceId]);
  const { requestLeave, confirmation } = usePageLeave({
    dirty: !!state.editor?.dirty,
    busy: state.saving,
    scope: JSON.stringify([state.context?.chatKey, state.context?.spaceId]),
    discard: workspace.discard,
    register: registerLeaveGuard,
  });
  const table = state.tables.find((item) => item.id === state.tableId);
  const back = () => {
    if (state.vectorPreview) {
      if (state.vectorPreview.record) void workspace.selectVectorRecord(null);
      else workspace.closeVectorPreview();
      return;
    }
    requestLeave(() => {
      if (state.editor) workspace.discard();
      else void workspace.selectTable(null);
    });
  };
  const title = state.vectorPreview
    ? state.vectorPreview.record
      ? "向量输入预览"
      : "选择预览记录"
    : state.editor
      ? {
          table: state.editor.kind === "table" && !state.editor.original ? "创建表格" : "编辑表格",
          field: "编辑字段",
          display: "显示策略",
          vector: "向量索引",
        }[state.editor.kind]
      : (table?.name ?? "表格");
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={title}
        subtitle={
          state.vectorPreview
            ? `${state.vectorPreview.configuration ? "当前草稿" : "已保存配置"} · ${state.context?.title}`
            : state.editor
              ? "修改后保存到当前对话"
              : state.context?.title
        }
        icon={Table2}
        onBack={state.tableId || state.editor ? back : undefined}
        {...controls}
        busy={state.saving}
        actions={
          !state.editor && !state.tableId ? (
            <Button
              data-action="create-table"
              disabled={state.saving || !state.context}
              onClick={() => workspace.begin("table")}
            >
              <Plus />
              创建表格
            </Button>
          ) : undefined
        }
      />
      <PageContent
        key={viewKey}
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        data-page-scroll="tables"
      >
        <fieldset
          disabled={state.saving}
          className="ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-5 ste:border-0 ste:p-0"
        >
          {state.error ? (
            <PageError
              title="操作失败"
              error={state.error}
              onRetry={!state.editor ? () => void workspace.refresh() : undefined}
            />
          ) : null}
          {state.notice ? <StatusNotice>{state.notice}</StatusNotice> : null}
          {state.persistenceError ? (
            <StatusNotice variant="destructive">
              修改已提交，但对话文件保存失败：{state.persistenceError}
              <Button disabled={state.saving} onClick={() => void workspace.retryPersistence()}>
                重试文件保存
              </Button>
            </StatusNotice>
          ) : null}
          {!state.context ? (
            <PageEmpty title="请选择对话" />
          ) : state.loading ? (
            <p role="status">正在加载表结构…</p>
          ) : null}
          {state.vectorPreview ? (
            <VectorPreviewContent workspace={workspace} preview={state.vectorPreview} />
          ) : state.editor ? (
            <form
              id="ste-table-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void workspace.save();
              }}
            >
              <fieldset
                disabled={state.saving}
                className="ste:flex ste:min-w-0 ste:flex-col ste:gap-5 ste:border-0 ste:p-0"
              >
                <SchemaEditorFields
                  state={state}
                  presets={presets}
                  editor={
                    state.editor.kind === "table" || state.editor.kind === "field"
                      ? { ...state.editor, original: !!state.editor.original }
                      : state.editor
                  }
                  onChange={(editor) => {
                    if (editor.kind === "table" && state.editor?.kind === "table")
                      workspace.change({ ...editor, original: state.editor.original });
                    else if (editor.kind === "field" && state.editor?.kind === "field")
                      workspace.change({ ...editor, original: state.editor.original });
                    else if (editor.kind === "display" || editor.kind === "vector")
                      workspace.change(editor);
                  }}
                />
                {state.editor.kind === "display" || state.editor.kind === "vector" ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void workspace.preview()}
                    >
                      预览当前草稿
                    </Button>
                    {state.previews.map((preview, index) => (
                      <div
                        key={index}
                        className="ste:rounded-xl ste:bg-muted ste:p-3 ste:break-words"
                      >
                        {preview}
                      </div>
                    ))}
                  </>
                ) : null}
                {state.editor.kind === "vector" ? (
                  <Button
                    type="button"
                    variant="outline"
                    data-action="preview-vector-records"
                    onClick={() => void workspace.openVectorPreview()}
                  >
                    逐记录预览草稿输入
                  </Button>
                ) : null}
              </fieldset>
            </form>
          ) : table ? (
            <>
              <section className="ste:space-y-3">
                <div className="ste:flex ste:items-start ste:justify-between ste:gap-3">
                  <div>
                    <p className="ste:font-mono ste:text-sm ste:text-muted-foreground">
                      {table.key} · {table.enabled ? "已启用" : "已停用"}
                    </p>
                    <p className="ste:mt-2 ste:whitespace-pre-wrap ste:break-words">
                      {table.description || "暂无描述"}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => workspace.begin("table")}>
                    编辑表格
                  </Button>
                </div>
                {table.prompt ? (
                  <p className="ste:whitespace-pre-wrap ste:rounded-xl ste:bg-muted ste:p-3 ste:text-sm">
                    {table.prompt}
                  </p>
                ) : null}
              </section>
              <section className="ste:space-y-3">
                <div className="ste:flex ste:items-center ste:justify-between">
                  <h2 className="ste:text-lg ste:font-semibold">
                    字段 <span className="ste:text-muted-foreground">{state.fields.length}</span>
                  </h2>
                  <Button variant="outline" onClick={() => workspace.begin("field")}>
                    <Plus />
                    新增字段
                  </Button>
                </div>
                {state.fields.length ? (
                  state.fields.map((field) => (
                    <div
                      key={field.id}
                      className="ste:flex ste:items-center ste:gap-2 ste:rounded-2xl ste:border ste:p-3"
                    >
                      <Button
                        variant="ghost"
                        className="ste:h-auto ste:min-w-0 ste:flex-1 ste:flex-col ste:items-start ste:gap-1 ste:p-0 ste:text-left ste:whitespace-normal"
                        onClick={() => workspace.begin("field", field)}
                      >
                        <span className="ste:font-medium">
                          {field.name}
                          {field.required ? " *" : ""}
                        </span>
                        <span className="ste:text-xs ste:text-muted-foreground ste:break-all">
                          {field.key} · {field.type} · {field.enabled ? "启用" : "停用"}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除字段 ${field.name}`}
                        disabled={state.saving}
                        onClick={() =>
                          setDeletion({ kind: "field", fieldId: field.id, name: field.name })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))
                ) : (
                  <PageEmpty
                    title="尚未添加字段"
                    description="先创建字段，再配置记录的显示方式。"
                  />
                )}
              </section>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4 ste:whitespace-normal ste:text-left"
                onClick={() => workspace.begin("display")}
              >
                <span>
                  显示策略
                  <br />
                  <span className="ste:text-xs ste:text-muted-foreground">
                    {displayStrategySummary(table.displayStrategy, state.fields)}
                  </span>
                </span>
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => {
                  scroll.forget(JSON.stringify([...contextKey, state.tableId, "vector", null]));
                  workspace.begin("vector");
                }}
              >
                <span>向量索引 · {table.vectorIndex?.enabled ? "已启用" : "未启用"}</span>
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                data-action="preview-vector-records"
                disabled={state.loading}
                onClick={() => void workspace.openVectorPreview()}
              >
                逐记录向量预览
              </Button>
              <div className="ste:flex ste:flex-wrap ste:gap-2">
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => void workspace.index("build").catch(() => {})}
                >
                  补建索引
                </Button>
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => void workspace.index("rebuild").catch(() => {})}
                >
                  强制重算
                </Button>
                <Button
                  variant="outline"
                  disabled={state.saving}
                  onClick={() => setDeletion({ kind: "vectors", name: table.name })}
                >
                  清除向量
                </Button>
              </div>
              <Button
                variant="destructive"
                disabled={state.saving}
                onClick={() => setDeletion({ kind: "table", name: table.name })}
              >
                <Trash2 />
                删除表格
              </Button>
            </>
          ) : !state.loading && state.context ? (
            <>
              {state.tables.length ? (
                state.tables.map((item) => (
                  <Item
                    key={item.id}
                    render={<button type="button" />}
                    variant="outline"
                    data-action="open-table"
                    onClick={() => {
                      scroll.forget(JSON.stringify([...contextKey, item.id, null, null]));
                      void workspace.selectTable(item.id);
                    }}
                    className="ste:cursor-pointer ste:text-left ste:hover:bg-muted"
                  >
                    <Table2 className="ste:size-5 ste:shrink-0 ste:text-muted-foreground" />
                    <ItemContent>
                      <ItemTitle>{item.name}</ItemTitle>
                      <ItemDescription>
                        {item.key} · {item.enabled ? "启用" : "停用"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:shrink-0" />
                    </ItemActions>
                  </Item>
                ))
              ) : (
                <PageEmpty title="还没有表格" description="创建一张表，定义需要保存的记忆结构。" />
              )}
            </>
          ) : null}
        </fieldset>
      </PageContent>
      {state.editor && !state.vectorPreview ? (
        <SaveActions
          formId="ste-table-editor"
          busy={state.saving}
          dirty={state.editor.dirty}
          onCancel={back}
          saveAction={`save-${state.editor.kind}`}
        />
      ) : null}
      {confirmation}
      <ConfirmAction
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open) setDeletion(null);
        }}
        title={`删除${deletion?.name ?? ""}${deletion?.kind === "vectors" ? "的向量" : ""}？`}
        description={
          deletion?.kind === "table"
            ? "表格、字段及表内记录将被删除，其他表对这些记录的引用可能失效。此操作无法撤销。"
            : deletion?.kind === "field"
              ? "删除后此字段的数据将不可用；显示策略依赖的字段需要先更换显示策略。此操作无法撤销。"
              : "将清除这张表的向量索引，记忆正文、证据与修订保留。之后需要重新补建才能用于向量检索。"
        }
        confirmLabel="确认删除"
        destructive
        onConfirm={async () => {
          if (deletion?.kind === "vectors") await workspace.index("clear");
          else await workspace.remove(deletion?.fieldId);
          setDeletion(null);
        }}
      />
    </div>
  );
}
