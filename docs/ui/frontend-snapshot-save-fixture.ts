import type { ChatSnapshotSaveStatus } from "../../src/features/chat-mirror/chat-snapshot-persistence.ts";

/** 独立预览只模拟状态通知与请求归属，不访问 ST 或聊天文件。 */
export function createSnapshotSaveFixture(
  identities: readonly string[],
  currentIdentity: () => string,
  date: string,
) {
  const states = new Map<string, ChatSnapshotSaveStatus>(
    identities.map((identity) => [
      identity,
      { kind: "submitted", identity, completedAt: date, sizeBytes: 1000 },
    ]),
  );
  const listeners = new Set<() => void>();
  let generation = 0;
  let delay = 0;
  let nextError: string | null = null;
  let syncCalls = 0;
  let beforeStart: { message: string; delay: number } | null = null;
  function publish(identity: string, status: ChatSnapshotSaveStatus) {
    states.set(identity, status);
    for (const listener of listeners) {
      listener();
    }
  }
  function fail(identity: string, operation: "update" | "force-sync" | "replacement", message: string) {
    publish(identity, {
      kind: "failed",
      identity,
      operation,
      error: message,
      humanMsg: `${operation === "update" ? "已提交、未交给 ST 保存" : operation === "replacement" ? "候选空间已启用、尚未核验，旧辅助数据保留" : "强制同步未通过核验"}：${message}`,
    });
  }
  async function save(verify: boolean) {
    const identity = currentIdentity();
    const status = states.get(identity)!;
    if (status.kind === "saving" || status.kind === "verifying") {
      throw new Error("当前快照正在保存");
    }
    const token = generation;
    const operation = verify ? "force-sync" : "update";
    const wait = delay;
    const error = nextError;
    delay = 0;
    nextError = null;
    const rejection = beforeStart;
    beforeStart = null;
    if (rejection) {
      await new Promise((done) => setTimeout(done, rejection.delay));
      throw new Error(rejection.message);
    }
    if (verify) {
      syncCalls++;
    }
    publish(identity, { kind: "saving", identity, operation });
    if (verify) {
      publish(identity, { kind: "verifying", identity, operation });
    }
    await new Promise((done) => setTimeout(done, wait));
    if (token !== generation) {
      return;
    }
    if (error) {
      fail(identity, operation, error);
      throw new Error(error);
    }
    publish(identity, {
      kind: verify ? "verified" : "submitted",
      identity,
      completedAt: date,
      sizeBytes: 1000,
    });
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => states.get(currentIdentity())!,
    hasPendingWrites: () =>
      [...states.values()].some(
        (state) => state.kind === "failed" || state.kind === "saving" || state.kind === "verifying",
      ),
    forceSync: () => save(true),
    retry: () => {
      const state = states.get(currentIdentity())!;
      return save(state.kind === "failed" && state.operation !== "update");
    },
    showFailure: (message = "preview file failure", operation: "update" | "replacement" = "update") => fail(currentIdentity(), operation, message),
    delayNext: (ms: number) => {
      delay = ms;
    },
    failNext: (message: string) => {
      nextError = message;
    },
    syncCalls: () => syncCalls,
    failBeforeStart: (message: string, delay = 0) => {
      beforeStart = { message, delay };
    },
    leaveChat: () => {
      generation++;
      const identity = currentIdentity();
      const status = states.get(identity)!;
      if (status.kind === "saving" || status.kind === "verifying") {
        fail(identity, "force-sync", "对话已切换，请返回原对话后重试");
      }
    },
  };
}
