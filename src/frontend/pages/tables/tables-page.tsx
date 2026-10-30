import { SchemaEditorFields } from "../../components/schema-editor-fields.tsx";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Plus, Table2, Trash2 } from "lucide-react";
import type { MemoryFieldId } from "../../../features/memory/index.ts";
import { Button } from "../../primitives/button.tsx";
import { usePrimitivesActive } from "../../primitives/provider.tsx";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../primitives/item.tsx";
import { cn } from "../../primitives/utils.ts";
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
import { displayStrategySummary } from "../../models/memory/display-strategy-model.ts";
import { FIELD_TYPE_LABELS } from "../../models/memory/table-list-model.ts";
import type { TablesWorkspace } from "./tables-workspace.ts";
import { VectorPreviewContent } from "./vector-preview-content.tsx";

export function TablesPage({
  workspace,
  controls,
  registerLeaveGuard,
}: {
  workspace: TablesWorkspace;
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
  const listing = !state.editor && !state.tableId && !state.vectorPreview;
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
          className={cn(
            "ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:flex-col ste:border-0 ste:p-0",
            listing ? "ste:gap-4" : "ste:max-w-3xl ste:gap-5",
          )}
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
                      {state.editor.kind === "vector" ? "向量状态" : "预览当前草稿"}
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
            <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-6">
              <section className="ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                <div className="ste:flex ste:items-start ste:justify-between ste:gap-3 ste:p-4">
                  <div className="ste:min-w-0 ste:flex-1">
                    <p className="ste:font-mono ste:text-xs ste:text-muted-foreground">
                      {table.key} · {table.enabled ? "已开启" : "已关闭"}
                    </p>
                    <p className="ste:mt-2 ste:whitespace-pre-wrap ste:break-words ste:text-sm">
                      {table.description || "暂无描述"}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => workspace.begin("table")}>
                    编辑表格
                  </Button>
                </div>
                {table.prompt ? (
                  <details className="ste:border-t ste:border-border ste:p-4">
                    <summary className="ste:cursor-pointer ste:text-xs ste:font-medium ste:text-muted-foreground ste:hover:text-foreground">
                      Prompt
                    </summary>
                    <p className="ste:mt-2 ste:whitespace-pre-wrap ste:break-words ste:text-sm">
                      {table.prompt}
                    </p>
                  </details>
                ) : null}
              </section>

              <TableSection
                title={
                  <>
                    字段{" "}
                    <span className="ste:font-normal ste:text-muted-foreground">
                      {state.fields.length}
                    </span>
                  </>
                }
                action={
                  <Button variant="outline" size="sm" onClick={() => workspace.begin("field")}>
                    <Plus />
                    新增字段
                  </Button>
                }
              >
                {state.fields.length ? (
                  <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                    {state.fields.map((field) => (
                      <div
                        key={field.id}
                        role="listitem"
                        className="ste:flex ste:items-center ste:gap-2 ste:px-4 ste:py-2.5 ste:transition-colors ste:hover:bg-muted/60 ste:focus-within:bg-muted/60"
                      >
                        <button
                          type="button"
                          className="ste:flex ste:min-w-0 ste:flex-1 ste:flex-col ste:items-start ste:gap-0.5 ste:appearance-none ste:rounded-sm ste:border-0 ste:bg-transparent ste:p-0 ste:text-left ste:text-foreground ste:outline-none ste:focus-visible:ring-[3px] ste:focus-visible:ring-ring/50 ste:focus-visible:ring-inset"
                          onClick={() => workspace.begin("field", field)}
                        >
                          <span className="ste:text-sm ste:font-medium">
                            {field.name}
                            {field.required ? " *" : ""}
                          </span>
                          <span className="ste:text-xs ste:text-muted-foreground ste:break-all">
                            {FIELD_TYPE_LABELS[field.type]} · {field.key}
                          </span>
                        </button>
                        <span className="ste:shrink-0 ste:text-xs ste:text-muted-foreground">
                          {field.enabled ? "启用" : "停用"}
                        </span>
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
                    ))}
                  </ItemGroup>
                ) : (
                  <PageEmpty
                    title="尚未添加字段"
                    description="先创建字段，再配置记录的显示方式。"
                  />
                )}
              </TableSection>

              <TableSection title="显示与检索">
                <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                  <div role="listitem">
                    <Item
                      render={<button type="button" />}
                      onClick={() => workspace.begin("display")}
                      className="ste:rounded-none ste:px-4 ste:py-3 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                    >
                      <ItemContent>
                        <ItemTitle>显示策略</ItemTitle>
                        <ItemDescription className="ste:line-clamp-1">
                          {displayStrategySummary(table.displayStrategy, state.fields)}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  </div>
                  <div role="listitem">
                    <Item
                      render={<button type="button" />}
                      onClick={() => {
                        scroll.forget(
                          JSON.stringify([...contextKey, state.tableId, "vector", null]),
                        );
                        workspace.begin("vector");
                      }}
                      className="ste:rounded-none ste:px-4 ste:py-3 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                    >
                      <ItemContent>
                        <ItemTitle>向量索引</ItemTitle>
                        <ItemDescription className="ste:line-clamp-1">
                          {table.vectorIndex?.enabled ? "已启用" : "未启用"}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  </div>
                </ItemGroup>
              </TableSection>

              {table.vectorIndex?.enabled ? (
                <TableSection title="索引维护">
                  <div className="ste:flex ste:flex-wrap ste:gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={state.saving}
                      onClick={() => void workspace.index("build").catch(() => {})}
                    >
                      补建索引
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={state.saving}
                      onClick={() => void workspace.index("rebuild").catch(() => {})}
                    >
                      强制重算
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={state.saving}
                      onClick={() => setDeletion({ kind: "vectors", name: table.name })}
                    >
                      清除向量
                    </Button>
                  </div>
                </TableSection>
              ) : null}

              <TableSection title={<span className="ste:text-destructive">危险操作</span>}>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={state.saving}
                  className="ste:self-start"
                  onClick={() => setDeletion({ kind: "table", name: table.name })}
                >
                  <Trash2 />
                  删除表格
                </Button>
              </TableSection>
            </div>
          ) : !state.loading && state.context ? (
            <>
              {state.tables.length ? (
                <section className="ste:flex ste:flex-col ste:gap-3">
                  <p className="ste:text-xs ste:text-muted-foreground">
                    共 {state.tables.length} 张表 ·{" "}
                    {state.tables.filter((item) => item.enabled).length} 张已开启
                  </p>
                  <ItemGroup
                    aria-label="表格列表"
                    className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border"
                  >
                    {state.tables.map((item) => (
                      <div key={item.id} role="listitem">
                        <Item
                          render={<button type="button" />}
                          data-action="open-table"
                          onClick={() => {
                            scroll.forget(JSON.stringify([...contextKey, item.id, null, null]));
                            void workspace.selectTable(item.id);
                          }}
                          className="ste:cursor-pointer ste:rounded-none ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                        >
                          <ItemContent>
                            <ItemTitle>{item.name}</ItemTitle>
                            <ItemDescription className="ste:line-clamp-1">
                              {[item.key, item.description].filter(Boolean).join(" · ")}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <span className="ste:text-xs ste:text-muted-foreground">
                              {item.enabled ? "开启" : "关闭"}
                            </span>
                            <ChevronRight className="ste:size-4 ste:shrink-0 ste:text-muted-foreground" />
                          </ItemActions>
                        </Item>
                      </div>
                    ))}
                  </ItemGroup>
                </section>
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

function TableSection({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
      <div className="ste:flex ste:min-h-8 ste:items-center ste:justify-between ste:gap-3">
        <h2 className="ste:text-sm ste:font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
