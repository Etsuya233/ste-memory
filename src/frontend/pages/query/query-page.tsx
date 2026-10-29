import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowDown,
  MessageCircle,
  RefreshCw,
  Send,
  Square,
  Plus,
  MessagesSquare,
  Pencil,
  Trash2,
  FileCheck,
} from "lucide-react";
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
  PageHeader,
  PageContent,
  PageFooter,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { ConfirmAction, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
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
  const unsaved = useSyncExternalStore(
    subscribe,
    () => store.hasPendingWrites(),
    () => store.hasPendingWrites(),
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
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const following = useRef(true);
  const currentKey = useRef(key);
  currentKey.current = key;
  const scroll = usePageScroll(store, key, !!context && !list);
  const executing = useSyncExternalStore(
    subscribe,
    () => !!session && store.isExecuting(session.id),
    () => false,
  );
  const busy = executing || session?.status === "running" || session?.status === "committing";
  const runningElsewhere = !!session && busy && !executing;
  useEffect(() => {
    setDeleting(null);
    setDiscarding(false);
    setEditing(null);
    setList(false);
  }, [scope]);
  useLayoutEffect(() => {
    const element = scroll.ref.current;
    if (!element) return;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 80;
    setShowLatest(!following.current);
  }, [key, list, scroll.ref]);
  useLayoutEffect(() => {
    if (following.current && scroll.ref.current && !list)
      scroll.ref.current.scrollTop = scroll.ref.current.scrollHeight;
  }, [session?.messages, list, scroll.ref]);
  async function perform(action: () => void | Promise<unknown>) {
    const captured = key;
    try {
      await action();
    } catch (cause) {
      if (captured === currentKey.current)
        setNotice({ key: captured, text: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  function create() {
    if (!context) return;
    props.assertContext(context);
    const created = store.create(context);
    setSelected((current) => ({ ...current, [scope]: created.id }));
    setList(false);
    following.current = true;
  }
  async function refresh() {
    if (!context) return;
    setRefreshing(true);
    try {
      props.assertContext(context);
      await props.onDataChanged(context);
    } finally {
      setRefreshing(false);
    }
  }
  function send() {
    if (!context || !session || busy) return;
    props.assertContext(context);
    following.current = true;
    setShowLatest(false);
    setNotice(null);
    return props.service.run({ sessionId: session.id, text: session.draft.trim() });
  }
  return (
    <section className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="记忆助手"
        subtitle={context?.title}
        icon={MessageCircle}
        {...props.controls}
        onBack={props.onBack}
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新记录"
            disabled={!context || refreshing}
            onClick={() => void perform(refresh)}
            data-action="query-refresh"
          >
            <RefreshCw />
          </Button>
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
      {context && loaded ? (
        <div className="ste:flex ste:shrink-0 ste:items-center ste:gap-2 ste:border-b ste:px-4 ste:py-2">
          <Button
            variant="outline"
            className="ste:min-w-0 ste:flex-1"
            onClick={() => setList(!list)}
            data-action="assistant-sessions"
          >
            <MessagesSquare data-icon="inline-start" />
            <span className="ste:truncate">
              {list ? "返回会话" : (session?.title ?? "会话列表")}
            </span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="新建会话"
            onClick={() => void perform(create)}
            data-action="assistant-new"
          >
            <Plus />
          </Button>
        </div>
      ) : null}
      <PageContent
        key={list ? `list:${scope}` : key}
        ref={scroll.ref}
        onScroll={(event) => {
          scroll.onScroll(event);
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 80;
          setShowLatest(!following.current);
        }}
      >
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
            className="ste:mx-auto ste:flex ste:max-w-3xl ste:flex-col ste:gap-3"
          >
            {available.length ? (
              available.map((item) => (
                <div
                  key={item.id}
                  className="ste:flex ste:min-w-0 ste:flex-wrap ste:items-center ste:gap-2 ste:rounded-xl ste:border ste:p-3"
                >
                  {editing === item.id ? (
                    <form
                      className="ste:flex ste:w-full ste:gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(() => {
                          store.rename(item.id, name);
                          setEditing(null);
                        });
                      }}
                    >
                      <Field>
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
                        className="ste:min-w-0 ste:flex-1 ste:justify-start"
                        onClick={() => {
                          setSelected((current) => ({ ...current, [scope]: item.id }));
                          setList(false);
                        }}
                      >
                        <span className="ste:truncate">{item.title}</span>
                      </Button>
                      <span className="ste:text-xs ste:text-muted-foreground">
                        {item.status === "running"
                          ? "回答中"
                          : item.status === "committing"
                            ? "提交中"
                            : item.status === "interrupted"
                              ? "已中断"
                              : item.proposal.operations.length
                                ? "有待提交修改"
                                : `${item.messages.length} 条消息`}
                      </span>
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
                    </>
                  )}
                </div>
              ))
            ) : (
              <PageEmpty title="还没有会话" description="新建会话后，可以查询记忆或准备修改。" />
            )}
          </section>
        ) : (
          <section
            aria-label="记忆助手消息"
            className="ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-6"
          >
            {notice?.key === key ? (
              <StatusNotice variant="destructive">{notice.text}</StatusNotice>
            ) : null}
            {session?.messages.length ? (
              session.messages.map((message) => (
                <QueryMessage
                  key={message.id}
                  message={message}
                  onRefresh={() => void perform(refresh)}
                  refreshing={refreshing}
                />
              ))
            ) : (
              <PageEmpty
                title="想了解或修改哪段记忆？"
                description="助手可以查询表格、回答问题并准备修改，确认提交后才会写入记忆。"
              />
            )}
            {session?.commitUncertain ? (
              <StatusNotice variant="destructive">
                上次提交被中断，结果待核对。请先查询记录，放弃旧提案后再准备新的修改。
              </StatusNotice>
            ) : null}
            {session && !busy && session.proposal.operations.length ? (
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
                                <dt className="ste:break-all ste:font-medium">{change.field}</dt>
                                <dd className="ste:m-0 ste:min-w-0 ste:break-all ste:text-muted-foreground">
                                  <span>修改前：</span>
                                  {JSON.stringify(change.old)}
                                </dd>
                                <dd className="ste:m-0 ste:min-w-0 ste:break-all">
                                  <span>修改后：</span>
                                  {JSON.stringify(change.new)}
                                </dd>
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
                          !session.preview?.valid || !session.previewId || session.commitUncertain
                        }
                        data-action="assistant-confirm"
                        onClick={() =>
                          void perform(() => {
                            props.assertContext(context!);
                            return props.service.confirm(session.id, session.previewId!);
                          })
                        }
                      >
                        确认提交
                      </Button>
                      <Button variant="outline" onClick={() => setDiscarding(true)}>
                        放弃提案
                      </Button>
                    </ItemActions>
                  </ItemFooter>
                </Item>
              </section>
            ) : null}
            {!session ? (
              <Button className="ste:self-start" onClick={() => void perform(create)}>
                新建会话
              </Button>
            ) : null}
          </section>
        )}
      </PageContent>
      {context && session && !list ? (
        <PageFooter className="ste:block">
          <form
            className="ste:flex ste:flex-col ste:gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(send);
            }}
          >
            {showLatest ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ste:self-center"
                onClick={() => {
                  following.current = true;
                  scroll.ref.current!.scrollTop = scroll.ref.current!.scrollHeight;
                  setShowLatest(false);
                }}
              >
                <ArrowDown data-icon="inline-start" />
                最新消息
              </Button>
            ) : null}
            <Field data-disabled={busy}>
              <FieldLabel htmlFor="query-chat-input" className="ste:sr-only">
                消息内容
              </FieldLabel>
              <InputGroup data-disabled={busy}>
                <InputGroupTextarea
                  id="query-chat-input"
                  aria-label="消息内容"
                  aria-describedby="query-chat-status"
                  data-action="query-chat-input"
                  rows={2}
                  className="ste:max-h-40 ste:overflow-y-auto"
                  value={session.draft}
                  disabled={busy}
                  placeholder={busy ? "助手正在处理…" : "查询记忆，或描述要修改的内容…"}
                  onChange={(event) => store.setDraft(session.id, event.target.value)}
                />
                <InputGroupAddon align="block-end" className="ste:justify-between ste:gap-3">
                  <p
                    id="query-chat-status"
                    className="ste:min-w-0 ste:text-xs ste:font-normal ste:wrap-break-word"
                    role="status"
                  >
                    {runningElsewhere
                      ? "会话正在其他标签页处理。"
                      : busy
                        ? "可切换会话，结果会保留。"
                        : unsaved
                          ? "正在保存会话…"
                          : "会话保存在当前浏览器。"}
                  </p>
                  {executing && session.status !== "committing" ? (
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
