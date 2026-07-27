import { CircleAlert, Database, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SystemHealth } from "@ste-memory/core";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly health: SystemHealth }
  | { readonly status: "failed"; readonly message: string };

interface StatusRowProps {
  readonly connected: boolean;
  readonly detail: string;
  readonly icon: typeof Server;
  readonly label: string;
}

function StatusRow({ connected, detail, icon: Icon, label }: StatusRowProps) {
  return (
    <div className="status-row">
      <div className="status-icon">
        <Icon aria-hidden="true" size={18} />
      </div>
      <div className="status-copy">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <span className={`status-value ${connected ? "online" : "offline"}`}>
        <span className="status-dot" />
        {connected ? "已连接" : "不可用"}
      </span>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch(`${API_URL}/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState({ status: "loaded", health: (await response.json()) as SystemHealth });
    } catch (error) {
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : "未知错误",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="app-shell">
      <header>
        <div className="brand-mark">SM</div>
        <div>
          <h1>STE Memory</h1>
          <p>本地实验环境</p>
        </div>
      </header>
      <main>
        <div className="section-heading">
          <div>
            <h2>系统状态</h2>
            <p>当前 API 与数据存储连接</p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={state.status === "loading"}
            title="刷新状态"
            aria-label="刷新状态"
          >
            <RefreshCw size={17} className={state.status === "loading" ? "spinning" : ""} />
          </button>
        </div>
        <section className="status-panel" aria-live="polite">
          {state.status === "loading" && <div className="message">正在检查连接...</div>}
          {state.status === "failed" && (
            <div className="message error">
              <CircleAlert size={18} />
              无法连接 API：{state.message}
            </div>
          )}
          {state.status === "loaded" && (
            <>
              <StatusRow
                icon={Server}
                label="HTTP API"
                connected={state.health.api === "ok"}
                detail={API_URL}
              />
              <StatusRow
                icon={Database}
                label="Core SQLite"
                connected={state.health.databases.core.connected}
                detail="记忆领域数据"
              />
              <StatusRow
                icon={Database}
                label="Source Store SQLite"
                connected={state.health.databases.sourceStore.connected}
                detail="HTTP Adapter 来源数据"
              />
            </>
          )}
        </section>
      </main>
      <footer>仅监听本机网络接口</footer>
    </div>
  );
}
