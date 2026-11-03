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
    verify: vi.fn(async (owner) => {
      const content = files.get(owner.identity)!;
      return {
        steMemory: content.binding,
        steMemoryMirror: createChatMirrorFile(
          content.unit,
          content.binding.spaceId,
          content.unit.space.updatedAt,
          "test",
        ),
      };
    }),
    submit: vi.fn(async (owner, file, binding) => {
      store.restore(owner, file, binding);
      files.set(owner.identity, { binding, unit: file.data });
    }),
    restore: vi.fn((owner, _file, binding) => {
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
  const legacyFloorLedger = {
    read: vi.fn(async (_id: MemorySpaceId): Promise<MemorySpaceBackup["floorLedger"]> => []),
    remove: vi.fn(async (_id: MemorySpaceId) => {}),
  };
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
    legacyFloorLedger,
    createSnapshot: async () => sample(),
    validateSnapshot: validate,
    activateSnapshot: activate,
    unloadSnapshot: async (id) => {
      memory.delete(id);
    },
    stopSpaceWrites: stop,
    captureRetirement: (id) => () => retire(id),
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
    legacyFloorLedger,
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
  it("初始化和导入先启用候选，失败保留候选与旧辅助，核验后清理", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const original = h.manager.getStatus();
    vi.mocked(h.store.submit).mockImplementationOnce(async (target, file, binding) => {
      h.store.restore(target, file, binding);
      throw new Error("offline");
    });
    await expect(h.manager.importSpace(h.sample())).rejects.toThrow("候选空间已启用");
    expect(h.manager.getStatus()).not.toEqual(original);
    expect(h.metadata.get(h.target().identity)!.spaceId).not.toBe("space");
    expect(h.retire).not.toHaveBeenCalled();
    const pending = h.persistence.current(h.target().identity)!;
    await h.persistence.forceSync(h.target(), pending.binding, pending.snapshot, () => {});
    const status = h.manager.getStatus();
    expect(status?.kind).toBe("active");
    expect(status?.kind === "active" && status.space.id).not.toBe("space");
    expect(h.retire).toHaveBeenCalledWith("space");
  });

  it("已有文件快照但缺绑定时拒绝初始化，不覆盖唯一持久化内容", async () => {
    const h = harness();
    const source = h.sample();
    h.files.set(h.target().identity, {
      unit: source,
      binding: { version: 1, spaceId: source.space.id },
    });
    await expect(h.manager.syncToCurrentChat()).rejects.toThrow("已有记忆快照但缺少空间绑定");
    expect(h.store.submit).not.toHaveBeenCalled();
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

describe("旧楼层进度迁移", () => {
  const progress = [{ floor: 7, status: "processed" as const, updatedAt: "now" }];

  it("原文件绑定精确匹配时迁入旧进度，完整文件核验后才清理", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    h.files.set(h.target().identity, { binding, unit });
    h.legacyFloorLedger.read.mockResolvedValue(progress);
    vi.mocked(h.store.verify).mockImplementationOnce(async () => {
      expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
      const file = h.files.get(h.target().identity)!;
      expect(file.unit.floorLedger).toEqual(progress);
      return {
        steMemory: file.binding,
        steMemoryMirror: createChatMirrorFile(
          file.unit,
          file.unit.space.id,
          file.unit.space.updatedAt,
          "test",
        ),
      };
    });
    await h.manager.syncToCurrentChat();
    expect(h.legacyFloorLedger.read).toHaveBeenCalledWith(unit.space.id);
    expect(h.legacyFloorLedger.remove).toHaveBeenCalledExactlyOnceWith(unit.space.id);
  });

  it.each(["save", "verify"])(
    "%s 失败保留旧台账和候选，强制同步重试不再次读取旧进度",
    async (phase) => {
      const h = harness();
      const unit = h.sample();
      const binding: ChatSpaceBinding = {
        version: 2,
        spaceId: unit.space.id,
        chatIdentity: h.target().identity,
      };
      h.metadata.set(h.target().identity, binding);
      h.files.set(h.target().identity, { binding, unit });
      h.legacyFloorLedger.read.mockResolvedValue(progress);
      if (phase === "save") {
        vi.mocked(h.store.submit).mockRejectedValueOnce(new Error("offline"));
      } else {
        vi.mocked(h.store.verify).mockResolvedValueOnce({});
      }
      await expect(h.manager.syncToCurrentChat()).rejects.toThrow("尚未核验");
      expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
      const pending = h.persistence.current(h.target().identity)!;
      expect(pending.snapshot.floorLedger).toEqual(progress);
      await h.persistence.forceSync(h.target(), pending.binding, pending.snapshot, () => {});
      expect(h.legacyFloorLedger.remove).toHaveBeenCalledOnce();
      expect(h.legacyFloorLedger.read).toHaveBeenCalledOnce();
    },
  );

  it("聊天已有进度时完整保留，不读取或清理本机旧台账", async () => {
    const h = harness();
    const unit = { ...h.sample(), floorLedger: progress };
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    h.files.set(h.target().identity, { binding, unit });
    await h.manager.syncToCurrentChat();
    expect(h.persistence.current(h.target().identity)!.snapshot).toEqual(unit);
    expect(h.legacyFloorLedger.read).not.toHaveBeenCalled();
    expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
  });

  it("旧台账不存在时保留空进度，不额外保存或清理", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    h.files.set(h.target().identity, { binding, unit });
    await h.manager.syncToCurrentChat();
    expect(h.persistence.current(h.target().identity)!.snapshot).toEqual(unit);
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
  });

  it("分支和移植文件不借用本机同空间旧台账", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: "char:8:other-chat",
    };
    h.metadata.set(h.target().identity, binding);
    h.files.set(h.target().identity, { binding, unit });
    expect((await h.manager.syncToCurrentChat()).kind).toBe("branch-detected");
    expect(h.legacyFloorLedger.read).not.toHaveBeenCalled();
    expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
  });

  it("核验期间切换聊天保留旧台账，回到原聊天可继续核验与清理", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    const target = h.target();
    h.metadata.set(target.identity, binding);
    h.files.set(target.identity, { binding, unit });
    h.legacyFloorLedger.read.mockResolvedValue(progress);
    const hold = gate();
    vi.mocked(h.store.verify).mockImplementationOnce(async () => {
      await hold.promise;
      const file = h.files.get(target.identity)!;
      return {
        steMemory: file.binding,
        steMemoryMirror: createChatMirrorFile(
          file.unit,
          file.unit.space.id,
          file.unit.space.updatedAt,
          "test",
        ),
      };
    });
    const saving = h.manager.syncToCurrentChat();
    const rejected = expect(saving).rejects.toThrow("尚未核验");
    await vi.waitFor(() => expect(h.store.verify).toHaveBeenCalledOnce());
    h.select("B");
    hold.release();
    await rejected;
    expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
    h.select("A");
    await h.manager.syncToCurrentChat();
    const pending = h.persistence.current(target.identity)!;
    await h.persistence.forceSync(target, pending.binding, pending.snapshot, () => {});
    expect(h.legacyFloorLedger.remove).toHaveBeenCalledExactlyOnceWith(unit.space.id);
    expect(h.legacyFloorLedger.read).toHaveBeenCalledOnce();
  });

  it("读取旧台账期间切换聊天，不激活、保存或清理旧结果", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    h.files.set(h.target().identity, { binding, unit });
    h.legacyFloorLedger.read.mockImplementationOnce(async () => {
      h.select("B");
      return progress;
    });
    expect((await h.manager.syncToCurrentChat()).kind).toBe("load-error");
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.legacyFloorLedger.remove).not.toHaveBeenCalled();
  });
});
