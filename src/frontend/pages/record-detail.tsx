import { useId, useState, type RefObject } from "react";
import { Check, LoaderCircle, Pencil } from "lucide-react";
import type {
  StChatMessage,
  FloorJumpResult,
} from "../../infrastructure/sillytavern/chat-adapter.ts";
import type { RecordsWorkspace, RecordsSnapshot } from "./records-workspace.ts";
import { RecordFieldInput, referenceLabels } from "../components/record-fields.tsx";
import { recordFieldValueText } from "../../ui/memory/record-form-model.ts";
import { Button } from "../../ui/primitives/button.tsx";
import { Badge } from "../../ui/primitives/badge.tsx";
import { Field, FieldLabel, FieldGroup } from "../../ui/primitives/field.tsx";
import { Alert, AlertTitle, AlertDescription } from "../../ui/primitives/alert.tsx";
import { Skeleton } from "../../ui/primitives/skeleton.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../ui/primitives/accordion.tsx";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "../../ui/primitives/tooltip.tsx";
export function RecordDetailPage({
  state,
  workspace,
  detailRef,
  formRef,
  formId,
  navigate,
  runHost,
  getMessageAt,
  onJumpFloor,
  onRetrySave,
}: {
  state: RecordsSnapshot;
  workspace: RecordsWorkspace;
  detailRef: RefObject<HTMLHeadingElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  formId: string;
  navigate: (action: () => void) => void;
  runHost: (action: () => Promise<unknown>) => Promise<void>;
  getMessageAt: (floor: number) => StChatMessage | undefined;
  onJumpFloor: (floor: number) => FloorJumpResult;
  onRetrySave: () => Promise<void>;
}) {
  const table = state.tables.find((item) => item.id === state.tableId);
  const labels = referenceLabels(state.references);
  return (
    <section
      className="ste:flex ste:min-h-0 ste:flex-1 ste:flex-col"
      aria-label={state.editor ? "记录编辑" : "记录详情"}
    >
      <div
        className="ste:min-h-0 ste:flex-1 ste:overflow-y-auto ste:overscroll-contain ste:p-5"
        key={state.detailId ?? "new"}
      >
        <div className="ste:mb-6 ste:flex ste:flex-col ste:gap-2">
          <p className="ste:text-xs ste:text-muted-foreground">{table?.name}</p>
          <h2
            ref={detailRef}
            tabIndex={-1}
            className="ste:wrap-anywhere ste:text-xl ste:font-semibold ste:tracking-tight ste:outline-none"
          >
            {state.editor?.original?.displayText ??
              state.detail?.displayText ??
              (state.editor ? "新建记录" : "正在加载…")}
          </h2>
          {!state.editor && state.detail ? (
            <p className="ste:text-xs ste:text-muted-foreground">
              更新于 {state.detail.updatedAt.slice(0, 16).replace("T", " ")}
            </p>
          ) : null}
        </div>
        {state.detailLoading ? <Skeleton className="ste:h-48 ste:w-full" /> : null}
        {state.detailError ? (
          <Alert variant="destructive">
            <AlertTitle>记录暂不可用</AlertTitle>
            <AlertDescription>{state.detailError}</AlertDescription>
          </Alert>
        ) : null}
        {state.editor ? (
          <form
            id={formId}
            ref={formRef}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void workspace.save();
            }}
          >
            <fieldset disabled={state.saving} className="ste:m-0 ste:min-w-0 ste:border-0 ste:p-0">
              <FieldGroup>
                {state.editor.fields.map((field) =>
                  field.enabled ? (
                    <RecordFieldInput
                      key={field.id}
                      field={field}
                      value={state.editor!.draft.values[field.id]!}
                      references={state.references}
                      error={state.editor!.errors[field.id]}
                      onChange={(value) => workspace.setField(field.id, value)}
                    />
                  ) : (
                    <Field key={field.id}>
                      <FieldLabel>
                        {field.name}
                        <Badge variant="secondary">已停用</Badge>
                      </FieldLabel>
                      <p className="ste:wrap-anywhere ste:whitespace-pre-wrap ste:text-muted-foreground">
                        {recordFieldValueText(
                          field,
                          state.editor!.original?.payload[field.id],
                          labels,
                        )}
                      </p>
                    </Field>
                  ),
                )}
              </FieldGroup>
            </fieldset>
            {state.editor.error ? (
              <Alert variant="destructive" className="ste:mt-6">
                <AlertTitle>
                  {state.editor.conflict ? "记录已变化，草稿已保留" : "尚未保存"}
                </AlertTitle>
                <AlertDescription>
                  {state.editor.error}
                  {state.editor.conflict ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void runHost(() =>
                          navigator.clipboard.writeText(
                            JSON.stringify(state.editor!.draft.values, null, 2),
                          ),
                        )
                      }
                    >
                      复制草稿
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </form>
        ) : state.detail ? (
          <div className="ste:flex ste:flex-col ste:gap-6">
            {state.fields.map((field) => (
              <div key={field.id} className="ste:flex ste:flex-col ste:gap-2">
                <div className="ste:flex ste:items-center ste:gap-2">
                  <span className="ste:text-xs ste:font-medium ste:text-muted-foreground">
                    {field.name}
                  </span>
                  {!field.enabled ? <Badge variant="secondary">已停用</Badge> : null}
                </div>
                <p className="ste:wrap-anywhere ste:whitespace-pre-wrap ste:leading-relaxed">
                  {recordFieldValueText(field, state.detail!.payload[field.id], labels)}
                </p>
                <div className="ste:flex ste:flex-wrap ste:gap-2">
                  {(state.detail!.fieldEvidence[field.id] ?? [])
                    .filter(
                      (evidence) =>
                        evidence.source_type === "sync_floor" &&
                        typeof evidence.source_id === "number",
                    )
                    .map((evidence, index) => (
                      <EvidenceChip
                        key={index}
                        floor={evidence.source_id as number}
                        getMessageAt={getMessageAt}
                        onJump={onJumpFloor}
                      />
                    ))}
                </div>
              </div>
            ))}
            {state.history.length ? (
              <Accordion>
                <AccordionItem value="history">
                  <AccordionTrigger>
                    修订历史 <Badge variant="secondary">{state.history.length}</Badge>
                  </AccordionTrigger>
                  <AccordionContent>
                    {state.history.map((entry) => (
                      <div key={entry.id} className="ste:mb-4 ste:flex ste:flex-col ste:gap-2">
                        <p className="ste:text-xs ste:text-muted-foreground">
                          {entry.archivedAt.slice(0, 16).replace("T", " ")}
                        </p>
                        {state.fields.map((field) => (
                          <p key={field.id} className="ste:wrap-anywhere ste:whitespace-pre-wrap">
                            <span className="ste:mr-2 ste:text-muted-foreground">{field.name}</span>
                            {recordFieldValueText(field, entry.payload[field.id], labels)}
                          </p>
                        ))}
                      </div>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            ) : null}
          </div>
        ) : null}
        {state.persistenceError ? (
          <Alert variant="destructive" className="ste:mt-4">
            <AlertTitle>记录已提交，写回尚未完成</AlertTitle>
            <AlertDescription>
              {state.persistenceError}
              <Button
                variant="outline"
                size="sm"
                data-action="retry-persistence"
                onClick={() => void onRetrySave()}
              >
                重试写回
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.saveWarning ? (
          <Alert className="ste:mt-4">
            <AlertTitle>记录已保存</AlertTitle>
            <AlertDescription>{state.saveWarning}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <footer className="ste:flex ste:shrink-0 ste:items-center ste:justify-between ste:gap-3 ste:border-t ste:border-border ste:bg-background ste:p-4 ste:pb-[max(1rem,env(safe-area-inset-bottom))]">
        {state.editor ? (
          <>
            <p role="status" className="ste:text-xs ste:text-muted-foreground">
              {state.saving ? "正在保存…" : state.editor.dirty ? "有未保存修改" : "尚未修改"}
            </p>
            <div className="ste:flex ste:gap-2">
              <Button
                variant="outline"
                data-action="cancel-edit"
                disabled={state.saving}
                onClick={() => navigate(() => workspace.cancelEdit())}
              >
                取消
              </Button>
              <Button
                type="submit"
                form={formId}
                data-action="save-record"
                disabled={state.saving || !state.editor.dirty || state.editor.conflict}
              >
                {state.saving ? (
                  <LoaderCircle data-icon="inline-start" className="ste:animate-spin" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                保存
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="ste:text-xs ste:text-muted-foreground">
              {state.detail?.source.type === "manual" ? "手动记录" : "来源于对话"}
            </span>
            <Button
              data-action="edit-record"
              disabled={
                !state.detail ||
                state.detailLoading ||
                !!state.detailError ||
                state.listLoading ||
                !!state.listError
              }
              onClick={() => workspace.startEdit()}
            >
              <Pencil data-icon="inline-start" />
              编辑记录
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}

function EvidenceChip({
  floor,
  getMessageAt,
  onJump,
}: {
  floor: number;
  getMessageAt: (floor: number) => StChatMessage | undefined;
  onJump: (floor: number) => FloorJumpResult;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const message = open ? getMessageAt(floor) : undefined;
  return (
    <TooltipProvider delay={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={<Button variant="secondary" size="xs" />}
          aria-label={`查看楼层 ${floor} 的证据`}
          aria-describedby={open ? id : undefined}
          onClick={() => {
            setOpen(true);
            const result = onJump(floor);
            if (result.kind !== "jumped") setHint("当前对话中未找到对应消息");
          }}
        >
          #{floor}
        </TooltipTrigger>
        <TooltipContent
          id={id}
          role="tooltip"
          className="ste:max-w-72 ste:flex-col ste:items-start"
        >
          <span className="ste:font-medium">{message?.name ?? `楼层 ${floor}`}</span>
          <span className="ste:max-h-40 ste:overflow-y-auto ste:whitespace-pre-wrap ste:wrap-anywhere">
            {message?.content ?? "当前对话中未找到对应消息"}
          </span>
          {hint ? <span>{hint}</span> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
