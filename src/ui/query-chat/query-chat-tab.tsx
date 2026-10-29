import type { QueryChatService } from "../../features/query-chat/query-chat-service.ts";
import type { QueryChatStore } from "../../features/query-chat/session-store.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import { QueryPage } from "../../frontend/pages/query/query-page.tsx";

export interface QueryChatTabRuntime {
  readonly queryChat: Pick<QueryChatService, "run" | "confirm" | "discard">;
}
/** 旧面板复用统一助手页面，生产默认入口在 frontend。 */
export function QueryChatTab(props: {
  readonly runtime: QueryChatTabRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  readonly store: QueryChatStore;
  readonly onDataChanged: () => void;
}) {
  const status = props.status;
  const context =
    props.settings.enabled && status?.kind === "active" && status.binding.version === 2
      ? { chatKey: status.binding.chatIdentity, spaceId: status.space.id, title: status.space.name }
      : null;
  return (
    <QueryPage
      context={context}
      store={props.store}
      service={props.runtime.queryChat}
      assertContext={(captured) => {
        if (
          !context ||
          captured.chatKey !== context.chatKey ||
          captured.spaceId !== context.spaceId
        )
          throw new Error("当前对话已切换");
      }}
      controls={{ onClose: () => undefined, onToggleTone: () => undefined }}
      onBack={() => undefined}
      onDataChanged={props.onDataChanged}
    />
  );
}
