import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowDown, MessageCircle, RefreshCw, Send, Square } from "lucide-react";
import type { QueryChatService } from "../../../features/query-chat/query-chat-service.ts";
import {
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  queryChatHistoryKey,
  type QueryChatMessage,
  type QueryChatMode,
  type QueryChatStore,
} from "../../../features/query-chat/query-chat-state.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { Field } from "../../../ui/primitives/field.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../ui/primitives/tabs.tsx";
import {
  PageHeader,
  PageContent,
  PageFooter,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import type { RecordsContext } from "../records-workspace.ts";
import { QueryMessage } from "./query-message.tsx";

export interface QueryServices {
  store: QueryChatStore;
  service: Pick<QueryChatService, "run">;
  assertContext: (context: RecordsContext) => void;
  onDataChanged: (context: RecordsContext) => void | Promise<void>;
}
export interface QueryPageProps extends QueryServices {
  context: RecordsContext | null;
  controls: PageControls;
  onBack: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}
const empty: readonly QueryChatMessage[] = [];

export function QueryPage(props: QueryPageProps) {
  const { store, context } = props;
  const subscribe = useCallback((listener: () => void) => store.onStoreChange(listener), [store]);
  const mode = useSyncExternalStore(subscribe, () => store.getMode());
  const key = context ? queryChatHistoryKey(context.spaceId, mode) : "unbound";
  const messages = useSyncExternalStore(subscribe, () => (context ? store.getHistory(key) : empty));
  const run = useSyncExternalStore(subscribe, () => (context ? store.getRun(key) : undefined));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = drafts[key] ?? "";
  const [notice, setNotice] = useState<{ key: string; text: string; error: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const following = useRef(true);
  const currentKey = useRef(key);
  currentKey.current = key;
  const scroll = usePageScroll(store, key, !!context);
  const dirty = Object.values(drafts).some((value) => value.trim().length > 0);
  const { requestLeave, confirmation } = usePageLeave({
    dirty,
    busy: false,
    scope: "query-drafts",
    discard: () => setDrafts({}),
    register: props.registerLeaveGuard,
  });
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  useLayoutEffect(() => {
    const element = scroll.ref.current;
    if (!element) return;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 80;
    setShowLatest(!following.current);
  }, [key, scroll.ref]);
  useLayoutEffect(() => {
    if (following.current && scroll.ref.current)
      scroll.ref.current.scrollTop = scroll.ref.current.scrollHeight;
  }, [messages, scroll.ref]);

  function send() {
    const text = input.trim();
    if (!text || !context || store.getRun(key)) return;
    try {
      props.assertContext(context);
    } catch (cause) {
      setNotice({ key, text: cause instanceof Error ? cause.message : String(cause), error: true });
      return;
    }
    const history = chatHistoryMessages(store.getHistory(key));
    const controller = new AbortController();
    following.current = true;
    setShowLatest(false);
    setNotice(null);
    setDrafts((current) => ({ ...current, [key]: "" }));
    const pending = createPendingAssistantMessage(crypto.randomUUID());
    store.beginRun(key, createUserMessage(crypto.randomUUID(), text), pending, controller);
    // The service emits terminal events for every outcome. Keep this run attached
    // to its original space and mode while the user visits other pages or chats.
    void props.service.run({
      mode,
      memorySpaceId: context.spaceId,
      messages: [...history, { role: "user", text }],
      signal: controller.signal,
      onEvent: (event) => {
        if (store.getRun(key)?.pendingId === pending.id) store.applyEvent(key, event);
      },
    });
  }
  async function refresh() {
    if (!context) return;
    const capturedKey = key;
    setRefreshing(true);
    try {
      props.assertContext(context);
      await props.onDataChanged(context);
      if (capturedKey === currentKey.current)
        setNotice({ key: capturedKey, text: "记录已刷新。", error: false });
    } catch (cause) {
      if (capturedKey === currentKey.current)
        setNotice({
          key: capturedKey,
          text: cause instanceof Error ? cause.message : String(cause),
          error: true,
        });
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <section className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="记忆问答"
        subtitle={context?.title}
        icon={MessageCircle}
        {...props.controls}
        onBack={() => requestLeave(props.onBack)}
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新记录"
            disabled={!context || refreshing}
            onClick={() => void refresh()}
            data-action="query-refresh"
          >
            <RefreshCw />
          </Button>
        }
      />
      <Tabs
        value={mode}
        onValueChange={(value) => store.setMode(value as QueryChatMode)}
        className="ste:min-h-0 ste:flex-1 ste:gap-0"
      >
        <div className="ste:shrink-0 ste:border-b ste:px-4 ste:py-2">
          <TabsList aria-label="问答模式">
            <TabsTrigger value="query">查询</TabsTrigger>
            <TabsTrigger value="fill">填写</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={mode} className="ste:flex ste:min-h-0 ste:flex-col">
          <PageContent
            ref={scroll.ref}
            onScroll={(event) => {
              scroll.onScroll(event);
              const element = event.currentTarget;
              following.current =
                element.scrollHeight - element.clientHeight - element.scrollTop <= 80;
              setShowLatest(!following.current);
            }}
          >
            {!context ? (
              <PageEmpty
                title="请先打开对话"
                description="绑定记忆空间后，可以向 Agent 提问或填写记忆。"
              />
            ) : (
              <section
                aria-label={mode === "query" ? "查询消息" : "填写消息"}
                className="ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-4"
              >
                {notice?.key === key ? (
                  <StatusNotice variant={notice.error ? "destructive" : "default"}>
                    {notice.text}
                  </StatusNotice>
                ) : null}
                {messages.length ? (
                  messages.map((message) => (
                    <QueryMessage
                      key={message.id}
                      message={message}
                      mode={mode}
                      onRefresh={() => void refresh()}
                      refreshing={refreshing}
                    />
                  ))
                ) : (
                  <PageEmpty
                    title={mode === "query" ? "想了解哪段记忆？" : "想新增或修改什么？"}
                    description={
                      mode === "query"
                        ? "Agent 可以查询当前空间中的表格和记录。"
                        : "向 Agent 说明需求，确认它列出的变更后再让它提交。"
                    }
                  />
                )}
              </section>
            )}
          </PageContent>
          {context ? (
            <PageFooter className="ste:block">
              <form
                className="ste:flex ste:flex-col ste:gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
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
                <Field>
                  <Textarea
                    id="query-chat-input"
                    aria-label={mode === "query" ? "问答内容" : "填写内容"}
                    data-action="query-chat-input"
                    rows={2}
                    value={input}
                    disabled={!!run}
                    placeholder={
                      run
                        ? "Agent 正在回答…"
                        : mode === "query"
                          ? "问问当前记忆…"
                          : "描述要填写的内容…"
                    }
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </Field>
                <div className="ste:flex ste:items-center ste:justify-between ste:gap-3">
                  <p className="ste:text-xs ste:text-muted-foreground" role="status">
                    {run
                      ? "回答会在后台继续，可切换页面。"
                      : "历史仅保留在本次页面中，刷新后清空。"}
                  </p>
                  {run ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => store.cancel(key)}
                      data-action="query-chat-stop"
                    >
                      <Square data-icon="inline-start" />
                      停止
                    </Button>
                  ) : (
                    <Button type="submit" disabled={!input.trim()} data-action="query-chat-send">
                      <Send data-icon="inline-start" />
                      发送
                    </Button>
                  )}
                </div>
              </form>
            </PageFooter>
          ) : null}
        </TabsContent>
      </Tabs>
      {confirmation}
    </section>
  );
}
