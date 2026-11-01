import { describe, expect, it, vi } from "vitest";
import {
  ChatSpaceManager,
  chatIdentityKey,
  type ChatSpaceBinding,
  type ChatSnapshot,
} from "./chat-space-manager.ts";
import {
  ChatSnapshotPersistence,
  type ChatSnapshotFileStore,
  type ChatFileTarget,
} from "../chat-mirror/chat-snapshot-persistence.ts";
import { createChatMirrorFile } from "../chat-mirror/chat-mirror-codec.ts";
import { migrateMemorySpaceSnapshot } from "../memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../memory-snapshot/snapshot-test-fixture.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";
import type {
  MemorySpaceId,
  MemoryTableId,
  MemoryFieldId,
  MemoryRecordId,
  MemoryRecordHistoryId,
  MemoryEvidenceId,
} from "../memory/index.ts";

function harness() {
  let chat: ChatSnapshot = { chatId: "A", characterId: 1, groupId: null, characterName: "角色" };
  const files = new Map<string, { binding: ChatSpaceBinding; unit: MemorySpaceBackup }>();
  const memory = new Map<string, MemorySpaceBackup>();
  const metadata = new Map<string, ChatSpaceBinding>();
  const sample = () =>
    migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacySnapshotFixture() });
  const target = (): ChatFileTarget => ({
    kind: "character",
    identity: chatIdentityKey(chat)!,
    chatId: chat.chatId!,
    avatarUrl: "actor.png",
  });
  const store: ChatSnapshotFileStore = {
    read: vi.fn(async (owner) => {
      const content = files.get(owner.identity);
      return content && createChatMirrorFile(content.unit, content.binding.spaceId, "now", "test");
    }),
    write: vi.fn(async (owner, file, binding) => {
      files.set(owner.identity, { binding, unit: file.data });
    }),
    publish: vi.fn((owner, _file, binding) => {
      if (owner.identity === target().identity) {
        metadata.set(owner.identity, binding);
      }
    }),
  };
  const persistence = new ChatSnapshotPersistence(store, () => "test");
  const validate = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const retire = vi.fn(async (id: MemorySpaceId) => {
    memory.delete(id);
  });
  const activate = vi.fn(
    async (_target: ChatFileTarget, _binding: ChatSpaceBinding, unit: MemorySpaceBackup) => {
      memory.set(unit.space.id, unit);
    },
  );
  let serial = 0;
  const manager = new ChatSpaceManager({
    getChat: () => chat,
    captureTarget: target,
    bindingStore: {
      read: () => {
        const binding = metadata.get(target().identity);
        return binding ? { kind: "bound", binding } : { kind: "none" };
      },
    },
    persistence,
    createSnapshot: async () => sample(),
    validateSnapshot: validate,
    activateSnapshot: activate,
    unloadSnapshot: async (id) => {
      memory.delete(id);
    },
    stopSpaceWrites: stop,
    retireSpace: retire,
    findSpace: async (id) => memory.get(id)?.space,
    now: () => "now",
    createIds: {
      space: () => `s-${++serial}` as MemorySpaceId,
      table: () => `t-${++serial}` as MemoryTableId,
      field: () => `f-${++serial}` as MemoryFieldId,
      record: () => `r-${++serial}` as MemoryRecordId,
      history: () => `h-${++serial}` as MemoryRecordHistoryId,
      evidence: () => `e-${++serial}` as MemoryEvidenceId,
      macro: () => `macro-${++serial}`,
      group: () => `g-${++serial}`,
    },
  });
  return {
    manager,
    persistence,
    store,
    files,
    metadata,
    sample,
    validate,
    stop,
    retire,
    activate,
    select(name: string) {
      manager.clearCurrent();
      chat = { ...chat, chatId: name };
    },
    target,
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

describe("当前聊天空间的候选提交", () => {
  it("初始化和导入均先同次保存binding与snapshot，成功后激活；失败保留旧空间", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const original = h.manager.getStatus();
    vi.mocked(h.store.write).mockRejectedValueOnce(new Error("offline"));
    await expect(h.manager.importSpace(h.sample())).rejects.toThrow("当前空间未替换");
    expect(h.manager.getStatus()).toEqual(original);
    expect(h.metadata.get(h.target().identity)!.spaceId).toBe("space");
    expect(h.retire).not.toHaveBeenCalled();
    await h.persistence.retry(h.target().identity);
    const status = h.manager.getStatus();
    expect(status?.kind).toBe("active");
    expect(status?.kind === "active" && status.space.id).not.toBe("space");
    expect(h.retire).toHaveBeenCalledWith("space", h.target());
  });

  it("已有文件快照但缺绑定时拒绝初始化，不覆盖唯一持久化内容", async () => {
    const h = harness();
    const source = h.sample();
    h.files.set(h.target().identity, {
      unit: source,
      binding: { version: 1, spaceId: source.space.id },
    });
    await expect(h.manager.syncToCurrentChat()).rejects.toThrow("已有记忆快照但缺少空间绑定");
    expect(h.store.write).not.toHaveBeenCalled();
    expect(h.files.get(h.target().identity)!.unit).toEqual(source);
  });

  it("候选校验期间切到B或A→B→A，旧请求不得停止或清理新context", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const deferred = gate();
    h.validate.mockImplementationOnce(async () => deferred.promise);
    const importing = h.manager.importSpace(h.sample());
    await Promise.resolve();
    await Promise.resolve();
    h.select("B");
    await h.manager.syncToCurrentChat();
    h.select("A");
    await h.manager.syncToCurrentChat();
    deferred.release();
    await expect(importing).rejects.toThrow("已过期");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("同聊天后启动的候选取代仍在校验的旧请求", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const deferred = gate();
    h.validate.mockImplementationOnce(async () => deferred.promise);
    const old = h.manager.importSpace(h.sample());
    await Promise.resolve();
    await Promise.resolve();
    await h.manager.importSpace(h.sample());
    deferred.release();
    await expect(old).rejects.toThrow("已过期");
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.retire).toHaveBeenCalledTimes(1);
  });

  it("分支克隆只读源快照，不清理原聊天辅助数据", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const source = h.files.get(h.target().identity)!;
    h.select("branch");
    h.metadata.set(h.target().identity, source.binding);
    h.files.set(h.target().identity, source);
    expect((await h.manager.syncToCurrentChat()).kind).toBe("branch-detected");
    await h.manager.resolveBranch({ action: "clone", sourceSpaceId: source.unit.space.id });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.files.get("char:1:A")!.unit.space.id).toBe("space");
    expect(h.files.get(h.target().identity)!.unit.space.id).not.toBe("space");
  });
});
