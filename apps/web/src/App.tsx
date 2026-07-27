import { Database, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createMemorySpace,
  deleteMemorySpace,
  listMemorySpaces,
  loadSourceChat,
  renameMemorySpace,
  type MemorySpace,
  type SourceMessage,
  type SourceParseError,
} from "./api/memory-spaces.ts";
import { ChatViewer } from "./components/ChatViewer.tsx";
import { SpaceDialog } from "./components/SpaceDialog.tsx";
import { SpaceList } from "./components/SpaceList.tsx";

type DialogState =
  { readonly mode: "create" } | { readonly mode: "rename" | "delete"; readonly space: MemorySpace };

export function App() {
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [messages, setMessages] = useState<SourceMessage[]>([]);
  const [parseErrors, setParseErrors] = useState<SourceParseError[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(true);
  const [loadingChat, setLoadingChat] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  const refreshSpaces = useCallback(async () => {
    setLoadingSpaces(true);
    setPageError(undefined);
    try {
      const result = await listMemorySpaces();
      setSpaces(result);
      setSelectedId((current) =>
        current && result.some((space) => space.id === current) ? current : result[0]?.id,
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法读取记忆空间");
    } finally {
      setLoadingSpaces(false);
    }
  }, []);

  useEffect(() => void refreshSpaces(), [refreshSpaces]);

  useEffect(() => {
    let active = true;
    if (!selectedId) {
      setMessages([]);
      setParseErrors([]);
      return;
    }
    setLoadingChat(true);
    void loadSourceChat(selectedId)
      .then((chat) => {
        if (!active) return;
        setMessages(chat.messages);
        setParseErrors(chat.errors);
      })
      .catch((error: unknown) => {
        if (active) setPageError(error instanceof Error ? error.message : "无法读取原始聊天");
      })
      .finally(() => {
        if (active) setLoadingChat(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  function openDialog(state: DialogState) {
    setDialogError(undefined);
    setDialog(state);
  }

  async function runDialogAction(action: () => Promise<void>) {
    setDialogBusy(true);
    setDialogError(undefined);
    try {
      await action();
      setDialog(undefined);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setDialogBusy(false);
    }
  }

  async function create(name: string, file: File) {
    await runDialogAction(async () => {
      const created = await createMemorySpace(name, file);
      setSpaces((current) => [created, ...current]);
      setSelectedId(created.id);
    });
  }

  async function rename(name: string) {
    if (!dialog || dialog.mode !== "rename") return;
    const id = dialog.space.id;
    await runDialogAction(async () => {
      const renamed = await renameMemorySpace(id, name);
      setSpaces((current) => current.map((space) => (space.id === id ? renamed : space)));
    });
  }

  async function remove() {
    if (!dialog || dialog.mode !== "delete") return;
    const id = dialog.space.id;
    await runDialogAction(async () => {
      await deleteMemorySpace(id);
      setSpaces((current) => {
        const remaining = current.filter((space) => space.id !== id);
        setSelectedId((selected) => (selected === id ? remaining[0]?.id : selected));
        return remaining;
      });
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">SM</div>
        <div className="brand-copy">
          <h1>STE Memory</h1>
          <span>本地对话记忆实验</span>
        </div>
        <button
          className="primary-button topbar-create"
          type="button"
          onClick={() => openDialog({ mode: "create" })}
        >
          <Plus size={17} /> 创建空间
        </button>
      </header>
      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <h2>记忆空间</h2>
              <span>{spaces.length} 个会话</span>
            </div>
            <button
              className="icon-button"
              type="button"
              title="刷新列表"
              aria-label="刷新列表"
              disabled={loadingSpaces}
              onClick={() => void refreshSpaces()}
            >
              <RefreshCw size={16} className={loadingSpaces ? "spinning" : ""} />
            </button>
          </div>
          {pageError ? <div className="page-error">API 连接失败：{pageError}</div> : null}
          {loadingSpaces && spaces.length === 0 ? (
            <div className="empty-list">正在读取...</div>
          ) : (
            <SpaceList
              spaces={spaces}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRename={(space) => openDialog({ mode: "rename", space })}
              onDelete={(space) => openDialog({ mode: "delete", space })}
            />
          )}
          <footer className="storage-note">
            <Database size={14} /> 原始消息保存在本机 Source Store
          </footer>
        </aside>
        <section className="viewer">
          <ChatViewer messages={messages} errors={parseErrors} loading={loadingChat} />
        </section>
      </main>
      {dialog ? (
        <SpaceDialog
          mode={dialog.mode}
          space={dialog.mode === "create" ? undefined : dialog.space}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(undefined)}
          onCreate={create}
          onRename={rename}
          onDelete={remove}
        />
      ) : null}
    </div>
  );
}
