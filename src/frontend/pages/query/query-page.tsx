import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronDown,
  FileCheck,
  MessageCircle,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { QueryTranscript } from "./query-transcript.tsx";
import type { QueryChatService } from "../../../features/query-chat/query-chat-service.ts";
import type { QueryChatStore } from "../../../features/query-chat/session-store.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from "../../../ui/primitives/input-group.tsx";
import {
  Item,
  ItemHeader,
  ItemTitle,
  ItemDescription,
  ItemContent,
  ItemActions,
  ItemFooter,
  ItemGroup,
  ItemMedia,
} from "../../../ui/primitives/item.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Field, FieldLabel } from "../../../ui/primitives/field.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/primitives/dropdown-menu.tsx";
import { cn } from "../../../ui/primitives/utils.ts";
import {
  PageHeader,
  PageContent,
  PageFooter,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { ConfirmAction, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import { formatCompactTime } from "../../components/format-time.ts";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import type { RecordsContext } from "../records-workspace.ts";
import { QueryMessage } from "./query-message.tsx";

export interface QueryServices {
  store: QueryChatStore;
  service: Pick<QueryChatService, "run" | "confirm" | "discard">;
  assertContext: (context: RecordsContext) => void;
  onDataChanged: (context: RecordsContext) => void | Promise<void>;
}
export interface QueryPageProps extends QueryServices {
  context: RecordsContext | null;
  controls: PageControls;
  onBack: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}

const starterPrompts = [
  "最近更新过哪些人物记录？",
  "总结最近发生的事件",
  "把某条记录的状态改一下",
] as const;

export function QueryPage(props: QueryPageProps) {
  const { store, context } = props;
  const subscribe = useCallback((listener: () => void) => store.onStoreChange(listener), [store]);
  const sessions = useSyncExternalStore(
    subscribe,
    () => store.getSessions(),
    () => store.getSessions(),
  );
  const loaded = useSyncExternalStore(
    subscribe,
    () => store.isLoaded(),
    () => store.isLoaded(),
  );
  const storageError = useSyncExternalStore(
    subscribe,
    () => store.storageError(),
    () => store.storageError(),
  );
  const [selected, setSelected] = useState<Record<string, string>>({});
  const scope = context ? JSON.stringify([context.chatKey, context.spaceId]) : "unbound";
  const available = sessions.filter(
    (session) => session.chatKey === context?.chatKey && session.spaceId === context?.spaceId,
  );
  const session = available.find((item) => item.id === selected[scope]) ?? available[0];
  const key = session?.id ?? scope;
  const [list, setList] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [notice, setNotice] = useState<{
    key: string;
    text: string;
    variant: "default" | "destructive";
  } | null>(null);
  const noticeTimeout = useRef<number | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const currentKey = useRef(key);
  currentKey.current = key;
  const scroll = usePageScroll(store, `list:${scope}`, !!context && list);
  const chatting = !!context && loaded && !list && !!session;
  const executing = useSyncExternalStore(
    subscribe,
    () => !!session && store.isExecuting(session.id),
    () => false,
  );
  const busy = executing || session?.status === "running" || session?.status === "committing";
  const committing = session?.status === "committing";
  const runningElsewhere = !!session && busy && !executing;
  useEffect(() => () => window.clearTimeout(noticeTimeout.current), []);
  useEffect(() => {
    setDeleting(null);
    setDiscarding(false);
    setEditing(null);
    setList(false);
  }, [scope]);
  async function perform(action: () => void | Promise<unknown>) {
    const captured = key;
    try {
      await action();
    } catch (cause) {
      if (captured === currentKey.current) {
        window.clearTimeout(noticeTimeout.current);
        setNotice({
          key: captured,
          text: cause instanceof Error ? cause.message : String(cause),
          variant: "destructive",
        });
      }
    }
  }
  function flash(key: string, text: string) {
    window.clearTimeout(noticeTimeout.current);
    setNotice({ key, text, variant: "default" });
    noticeTimeout.current = window.setTimeout(() => setNotice(null), 2500);
  }
  function selectSession(id: string) {
    setSelected((current) => ({ ...current, [scope]: id }));
    setList(false);
  }
  function create(text = "") {
    if (!context) return;
    props.assertContext(context);
    const created = store.create(context);
    if (text) store.setDraft(created.id, text);
    selectSession(created.id);
  }
  function pickStarter(prompt: string) {
    if (!session) {
      create(prompt);
      return;
    }
    store.setDraft(session.id, prompt);
    document.getElementById("query-chat-input")?.focus();
  }
  async function refresh() {
    if (!context) return;
    const captured = key;
    setRefreshing(true);
    try {
      props.assertContext(context);
      await props.onDataChanged(context);
      if (captured === currentKey.current) flash(captured, "记录已刷新");
    } finally {
      setRefreshing(false);
    }
  }
  function send() {
    if (!context || !session || busy) return;
    props.assertContext(context);
    setNotice(null);
    return props.service.run({ sessionId: session.id, text: session.draft.trim() });
  }
  const statusText = runningElsewhere ? "会话正在其他标签页处理。" : "";
  const sessionMeta = (item: (typeof available)[number]) => {
    const status =
      item.status === "running"
        ? "回答中"
        : item.status === "committing"
          ? "提交中"
          : item.status === "interrupted"
            ? "已中断"
            : item.proposal.operations.length
              ? "有待提交修改"
              : `${item.messages.length} 条消息`;
    return `${status} · ${formatCompactTime(item.updatedAt)}`;
  };
  return (
    <section className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={
          list ? (
            "会话"
          ) : loaded && session ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ste:-ml-2 ste:h-7 ste:min-w-0 ste:max-w-full ste:justify-start ste:gap-1 ste:px-2 ste:font-semibold"
                  />
                }
                aria-label={`切换会话：${session.title}`}
                data-action="assistant-menu"
              >
                <span className="ste:min-w-0 ste:truncate">{session.title}</span>
                <ChevronDown
                  className="ste:size-3.5 ste:shrink-0 ste:text-muted-foreground"
                  aria-hidden="true"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="ste:w-64 ste:max-w-[calc(100vw-2rem)]">
                <DropdownMenuRadioGroup value={session.id}>
                  {available.map((item) => (
                    <DropdownMenuRadioItem
                      key={item.id}
                      value={item.id}
                      closeOnClick
                      data-action="assistant-session-option"
                      className="ste:items-start ste:whitespace-normal"
                      onClick={() => selectSession(item.id)}
                    >
                      <span className="ste:flex ste:min-w-0 ste:flex-col ste:gap-0.5">
                        <span className="ste:truncate ste:text-sm ste:font-medium">
                          {item.title}
                        </span>
                        <span className="ste:text-xs ste:font-normal ste:text-muted-foreground">
                          {sessionMeta(item)}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-action="assistant-new"
                  onClick={() => void perform(() => create())}
                >
                  <Plus />
                  新建会话
                </DropdownMenuItem>
                <DropdownMenuItem data-action="assistant-sessions" onClick={() => setList(true)}>
                  <MessagesSquare />
                  管理会话
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-action="query-refresh"
                  disabled={refreshing}
                  onClick={() => void perform(refresh)}
                >
                  <RefreshCw className={refreshing ? "ste:motion-safe:animate-spin" : undefined} />
                  刷新记录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            "记忆助手"
          )
        }
        subtitle={context?.title}
        icon={MessageCircle}
        {...props.controls}
        onBack={list ? () => setList(false) : props.onBack}
        backLabel={list ? "返回对话" : "返回"}
        actions={
          list ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="新建会话"
              onClick={() => void perform(() => create())}
              data-action="assistant-new"
            >
              <Plus />
            </Button>
          ) : undefined
        }
      />
      {storageError ? (
        <StatusNotice variant="destructive">
          会话保存失败：{storageError}
          <Button variant="outline" size="sm" onClick={() => void perform(() => store.retrySave())}>
            重试保存
          </Button>
        </StatusNotice>
      ) : null}
      <div className="ste:relative ste:flex ste:min-h-0 ste:flex-1 ste:flex-col">
        {chatting ? (
          <QueryTranscript key={key} owner={store} sessionId={key}>
            {notice?.key === key ? (
              <MessageScroller.Item messageId="notice">
                <StatusNotice variant={notice.variant}>{notice.text}</StatusNotice>
              </MessageScroller.Item>
            ) : null}
            {session.messages.length ? (
              session.messages.map((message) => (
                <MessageScroller.Item
                  key={message.id}
                  messageId={message.id}
                  data-query-turn=""
                  scrollAnchor={message.kind === "user"}
                >
                  <QueryMessage
                    message={message}
                    onRefresh={() => void perform(refresh)}
                    refreshing={refreshing}
                  />
                </MessageScroller.Item>
              ))
            ) : (
              <MessageScroller.Item messageId="empty">
                <PageEmpty
                  title="想了解或修改哪段记忆？"
                  description="助手可以查询表格、回答问题并准备修改，确认提交后才会写入记忆。"
                >
                  <StarterPrompts onPick={pickStarter} />
                </PageEmpty>
              </MessageScroller.Item>
            )}
            {session.commitUncertain ? (
              <MessageScroller.Item messageId="commit-uncertain">
                <StatusNotice variant="destructive">
                  上次提交被中断，结果待核对。请先查询记录，放弃旧提案后再准备新的修改。
                </StatusNotice>
              </MessageScroller.Item>
            ) : null}
            {session.proposal.operations.length ? (
              <MessageScroller.Item messageId="proposal">
                <section aria-label="待提交修改" className="ste:min-w-0">
                  <Item variant="outline" size="sm">
                    <ItemHeader>
                      <ItemMedia variant="icon">
                        <FileCheck />
                      </ItemMedia>
                      <ItemContent className="ste:min-w-0">
                        <ItemTitle>待提交修改 · {session.proposal.operations.length} 项</ItemTitle>
                        <ItemDescription>核对以下差异，确认后写入记忆。</ItemDescription>
                      </ItemContent>
                    </ItemHeader>
                    <ItemGroup>
                      {session.preview?.operations.map((operation, index) => (
                        <Item key={index} variant="muted" size="sm" className="ste:min-w-0">
                          <ItemContent className="ste:min-w-0">
                            <div className="ste:flex ste:min-w-0 ste:flex-wrap ste:items-center ste:gap-2">
                              <Badge
                                variant={operation.op === "delete" ? "destructive" : "secondary"}
                              >
                                {{ create: "新增", update: "修改", delete: "删除" }[operation.op]}
                              </Badge>
                              <span className="ste:min-w-0 ste:break-words ste:font-medium">
                                {operation.tableKey} · {operation.display}
                              </span>
                            </div>
                            <dl className="ste:mt-2 ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
                              {operation.changes.map((change) => (
                                <div
                                  key={change.field}
                                  className="ste:flex ste:min-w-0 ste:flex-col ste:gap-1 ste:text-xs"
                                >
                                  <dt className="ste:break-all ste:font-mono ste:font-medium">
                                    {change.field}
                                  </dt>
                                  {operation.op === "create" ? null : (
                                    <DiffRow label="修改前" value={change.old} />
                                  )}
                                  {operation.op === "delete" ? null : (
                                    <DiffRow label="修改后" value={change.new} />
                                  )}
                                </div>
                              ))}
                            </dl>
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemGroup>
                    {session.preview?.errors.map((error, index) => (
                      <StatusNotice key={index} variant="destructive">
                        {error.message}
                      </StatusNotice>
                    ))}
                    {!session.preview ? (
                      <p className="ste:text-sm ste:text-muted-foreground">
                        发送消息让助手重新检查提案后，可查看差异并确认。
                      </p>
                    ) : null}
                    <ItemFooter>
                      <ItemActions className="ste:flex-wrap">
                        <Button
                          disabled={
                            !session.preview?.valid ||
                            !session.previewId ||
                            session.commitUncertain ||
                            busy
                          }
                          data-action="assistant-confirm"
                          onClick={() =>
                            void perform(() => {
                              props.assertContext(context!);
                              return props.service.confirm(session.id, session.previewId!);
                            })
                          }
                        >
                          {committing ? "提交中…" : "确认提交"}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setDiscarding(true)}
                        >
                          放弃提案
                        </Button>
                      </ItemActions>
                    </ItemFooter>
                  </Item>
                </section>
              </MessageScroller.Item>
            ) : null}
          </QueryTranscript>
        ) : (
          <PageContent
            key={list ? `list:${scope}` : key}
            ref={scroll.ref}
            onScroll={scroll.onScroll}
          >
            {notice?.key === key ? (
              <div className="ste:mx-auto ste:w-full ste:max-w-3xl ste:pb-4">
                <StatusNotice variant={notice.variant}>{notice.text}</StatusNotice>
              </div>
            ) : null}
            {!context ? (
              <PageEmpty title="请先打开对话" description="绑定记忆空间后，可以查询或修改记忆。" />
            ) : !loaded ? (
              <PageEmpty
                title={storageError ? "会话加载失败" : "正在加载会话…"}
                description="会话保存在当前浏览器。"
              />
            ) : list ? (
              <section
                aria-label="会话列表"
                className="ste:mx-auto ste:flex ste:w-full ste:max-w-3xl ste:flex-col ste:gap-2"
              >
                {available.map((item) => {
                  const active = item.id === session?.id;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "ste:flex ste:min-w-0 ste:items-start ste:gap-1 ste:rounded-xl ste:border ste:border-border ste:p-1",
                        active && "ste:bg-muted",
                      )}
                    >
                      {editing === item.id ? (
                        <form
                          className="ste:flex ste:w-full ste:items-end ste:gap-2 ste:p-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(() => {
                              store.rename(item.id, name);
                              setEditing(null);
                            });
                          }}
                        >
                          <Field className="ste:min-w-0 ste:flex-1">
                            <FieldLabel htmlFor="assistant-session-name">会话名称</FieldLabel>
                            <Input
                              id="assistant-session-name"
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                              autoFocus
                            />
                          </Field>
                          <Button type="submit" size="sm">
                            保存
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(null)}
                          >
                            取消
                          </Button>
                        </form>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            aria-current={active ? "true" : undefined}
                            data-action="assistant-session"
                            className="ste:h-auto ste:min-w-0 ste:flex-1 ste:flex-col ste:items-start ste:gap-0.5 ste:px-2 ste:py-1.5 ste:text-left"
                            onClick={() => selectSession(item.id)}
                          >
                            <span className="ste:line-clamp-2 ste:whitespace-normal ste:break-words ste:text-sm ste:font-medium">
                              {item.title}
                            </span>
                            <span className="ste:text-xs ste:font-normal ste:text-muted-foreground">
                              {sessionMeta(item)}
                            </span>
                          </Button>
                          <div className="ste:flex ste:shrink-0 ste:items-center">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`重命名 ${item.title}`}
                              onClick={() => {
                                setEditing(item.id);
                                setName(item.title);
                              }}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`删除 ${item.title}`}
                              disabled={item.status === "committing"}
                              onClick={() => setDeleting(item.id)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {available.length ? null : (
                  <PageEmpty title="还没有会话" description="新建会话后，可以查询记忆或准备修改。">
                    <Button
                      onClick={() => void perform(() => create())}
                      data-action="assistant-new"
                    >
                      <Plus data-icon="inline-start" />
                      新建会话
                    </Button>
                  </PageEmpty>
                )}
              </section>
            ) : !session ? (
              <PageEmpty
                icon={MessagesSquare}
                title="想了解或修改哪段记忆？"
                description="助手可以查询表格、回答问题并准备修改，确认提交后才会写入记忆。"
              >
                <Button onClick={() => void perform(() => create())} data-action="assistant-new">
                  <Plus data-icon="inline-start" />
                  新建会话
                </Button>
                <StarterPrompts onPick={pickStarter} />
              </PageEmpty>
            ) : null}
          </PageContent>
        )}
      </div>
      {context && session && !list ? (
        <PageFooter className="ste:block">
          <form
            className="ste:flex ste:flex-col ste:gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(send);
            }}
          >
            {statusText ? (
              <p
                id="query-chat-status"
                className="ste:min-w-0 ste:text-xs ste:font-normal ste:text-muted-foreground ste:wrap-break-word"
                role="status"
              >
                {statusText}
              </p>
            ) : null}
            <Field data-disabled={busy}>
              <FieldLabel htmlFor="query-chat-input" className="ste:sr-only">
                消息内容
              </FieldLabel>
              <InputGroup data-disabled={busy} className="ste:overflow-hidden">
                <InputGroupTextarea
                  id="query-chat-input"
                  aria-label="消息内容"
                  aria-describedby={statusText ? "query-chat-status" : undefined}
                  data-action="query-chat-input"
                  rows={1}
                  className="ste:min-h-0"
                  value={session.draft}
                  disabled={busy}
                  placeholder={busy ? "助手正在处理…" : "查询记忆，或描述要修改的内容…"}
                  onChange={(event) => store.setDraft(session.id, event.target.value)}
                />
                <InputGroupAddon
                  align="inline-end"
                  // 上游 inline-end 用负外边距收紧右侧留白，会溢出输入组 4px；收回外边距并用内边距补偿。
                  className="ste:self-end ste:pr-2 ste:has-[>button]:mr-0"
                >
                  {executing && !committing ? (
                    <InputGroupButton
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => store.cancel(session.id)}
                      data-action="query-chat-stop"
                    >
                      <Square data-icon="inline-start" />
                      停止
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      type="submit"
                      size="sm"
                      variant="default"
                      disabled={busy || !session.draft.trim() || !!storageError}
                      data-action="query-chat-send"
                    >
                      <Send data-icon="inline-start" />
                      发送
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </form>
        </PageFooter>
      ) : null}
      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="删除会话？"
        description="该会话的历史、输入草稿和未提交提案将删除，已提交的记忆记录保留。正在进行的回答会停止。"
        confirmLabel="删除会话"
        destructive
        onConfirm={async () => {
          await store.delete(deleting!);
        }}
      />
      <ConfirmAction
        open={discarding}
        onOpenChange={setDiscarding}
        title="放弃当前提案？"
        description="清除这份未提交修改，保留聊天记录。"
        confirmLabel="放弃提案"
        destructive
        onConfirm={() => props.service.discard(session!.id)}
      />
    </section>
  );
}

function StarterPrompts({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="ste:flex ste:flex-wrap ste:justify-center ste:gap-2">
      {starterPrompts.map((prompt) => (
        <Button
          key={prompt}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPick(prompt)}
        >
          {prompt}
        </Button>
      ))}
    </div>
  );
}

function DiffRow({ label, value }: { label: string; value: unknown }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <dd className="ste:m-0 ste:grid ste:min-w-0 ste:grid-cols-[auto_1fr] ste:items-start ste:gap-2">
      <span className="ste:text-muted-foreground">{label}</span>
      <span
        className={cn(
          "ste:min-w-0 ste:whitespace-pre-wrap ste:break-words ste:rounded ste:bg-muted ste:px-1.5 ste:py-0.5 ste:font-mono",
          empty && "ste:text-muted-foreground",
        )}
      >
        {formatDiffValue(value)}
      </span>
    </dd>
  );
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "空";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}
