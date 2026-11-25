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
import { CHAT_MIRROR_FORMAT } from "../chat-mirror/chat-mirror-file.ts";
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
  const replacing = new Set<string>();
  const validate = vi.fn(async () => {});
  const stop = vi.fn(async (_id: MemorySpaceId) => {});
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
    prepareReplacement: async (_target, id) => {
      replacing.add(_target.identity);
      if (id) {
        await stop(id);
      }
      return () => {
        replacing.delete(_target.identity);
      };
    },
    assertCanReplace: (target) => {
      if (replacing.has(target.identity) || persistence.hasPendingReplacement(target.identity)) {
        throw new Error("当前对话的空间替换尚未完成，请先处理保存结果");
      }
    },
    reportError: vi.fn(),
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

describe("聊天文件的冲突快照恢复", () => {
  function conflict() {
    const h = harness();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: "other-space" as MemorySpaceId,
      chatIdentity: h.target().identity,
    };
    const source = legacySnapshotFixture();
    const file = {
      format: CHAT_MIRROR_FORMAT,
      version: 1,
      spaceId: source.space.id,
      updatedAt: "2026-09-19T15:25:17.158Z",
      appVersion: "0.1.3",
      data: source,
    };
    h.metadata.set(h.target().identity, binding);
    vi.mocked(h.store.read).mockResolvedValueOnce(file).mockResolvedValueOnce(file);
    return { ...h, file, binding };
  }

  it("预览旧快照不写入，显式恢复后复制新空间并可从文件重新加载", async () => {
    const h = conflict();
    const preview = await h.manager.syncToCurrentChat();
    expect(preview).toMatchObject({
      kind: "snapshot-conflict",
      name: h.file.data.space.name,
      updatedAt: h.file.updatedAt,
      tableCount: h.file.data.tables.length,
      recordCount: h.file.data.records.length,
      hasFloorProgress: false,
    });
    if (preview.kind !== "snapshot-conflict") {
      throw new Error("缺少恢复预览");
    }
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();

    await h.manager.recoverFileSnapshot(preview);
    const saved = h.files.get(h.target().identity)!;
    expect(saved.binding.spaceId).toBe(saved.unit.space.id);
    expect(saved.binding.spaceId).not.toBe(h.binding.spaceId);
    expect(saved.binding.spaceId).not.toBe(h.file.spaceId);
    expect(saved.unit.records).toHaveLength(h.file.data.records.length);
    expect(saved.unit.history).toHaveLength(h.file.data.history.length);
    expect(saved.unit.evidence).toHaveLength(h.file.data.evidence.length);
    expect(h.persistence.getStatus(h.target().identity).kind).toBe("verified");
    expect(h.manager.getStatus()).toMatchObject({ kind: "active", recoveredFromFile: true });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();

    h.select("A");
    expect(await h.manager.syncToCurrentChat()).toMatchObject({
      kind: "active",
      binding: saved.binding,
      restored: true,
    });
  });

  it("核验失败可重试同一份候选，核验前没有恢复成功标记", async () => {
    const h = conflict();
    const preview = await h.manager.syncToCurrentChat();
    if (preview.kind !== "snapshot-conflict") {
      throw new Error("缺少恢复预览");
    }
    vi.mocked(h.store.verify).mockRejectedValueOnce(new Error("offline"));
    await expect(h.manager.recoverFileSnapshot(preview)).rejects.toThrow("offline");
    expect(h.manager.getStatus()).not.toHaveProperty("recoveredFromFile");
    const pending = h.persistence.current(h.target().identity)!;
    await h.persistence.forceSync(h.target(), pending.binding, pending.snapshot, () => {});
    expect(h.manager.getStatus()).toMatchObject({ kind: "active", recoveredFromFile: true });
    expect(h.files.get(h.target().identity)?.binding).toEqual(pending.binding);
    expect(h.activate).toHaveBeenCalledOnce();
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("预览后即使回到同一个聊天，旧确认也不能保存", async () => {
    const h = conflict();
    const preview = await h.manager.syncToCurrentChat();
    if (preview.kind !== "snapshot-conflict") {
      throw new Error("缺少恢复预览");
    }
    h.select("B");
    h.select("A");
    await h.manager.syncToCurrentChat();
    await expect(h.manager.recoverFileSnapshot(preview)).rejects.toThrow("重新加载");
    expect(h.store.submit).not.toHaveBeenCalled();
  });

  it.each(["binding", "snapshot"])("确认前 %s 变化时拒绝覆盖", async (changed) => {
    const h = conflict();
    const preview = await h.manager.syncToCurrentChat();
    if (preview.kind !== "snapshot-conflict") {
      throw new Error("缺少恢复预览");
    }
    if (changed === "binding") {
      h.metadata.set(h.target().identity, { ...h.binding, spaceId: h.sample().space.id });
    } else {
      vi.mocked(h.store.read).mockReset();
      vi.mocked(h.store.read).mockResolvedValue({
        ...h.file,
        data: { ...h.file.data, space: { ...h.file.data.space, name: "更新后的名称" } },
      });
    }
    await expect(h.manager.recoverFileSnapshot(preview)).rejects.toThrow("重新加载");
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it.each(["missing", "unsupported", "inconsistent"])("%s 快照不可直接恢复", async (problem) => {
    const h = conflict();
    vi.mocked(h.store.read).mockReset();
    vi.mocked(h.store.read).mockResolvedValue(
      problem === "missing"
        ? undefined
        : problem === "unsupported"
          ? { ...h.file, version: 999 }
          : { ...h.file, spaceId: "wrong-envelope-space" },
    );
    await expect(h.manager.syncToCurrentChat()).rejects.toThrow(/没有记忆快照|损坏或版本无法识别/);
    expect(h.store.submit).not.toHaveBeenCalled();
  });
});

describe("当前聊天空间的候选提交", () => {
  it("初始化和导入先启用候选，失败保留候选与旧辅助，核验后清理", async () => {
    const h = harness();
    await h.manager.syncToCurrentChat();
    const original = h.manager.getStatus();
    vi.mocked(h.store.submit).mockImplementationOnce(async (target, file, binding) => {
      h.store.restore(target, file, binding);
      throw new Error("offline");
    });
    await expect(h.manager.importSpace(h.sample())).rejects.toThrow("新内容已载入");
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

describe("加载候选的通用激活流程", () => {
  it("加载结果要求替换时先激活候选，保存失败保持待重试，核验成功后运行回调", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    const confirmed = vi.fn(async () => {});
    vi.spyOn(h.persistence, "load").mockResolvedValueOnce({
      snapshot: unit,
      replacement: { confirmed },
    });
    vi.mocked(h.store.submit).mockImplementationOnce(async () => {
      expect(h.manager.getStatus()).toMatchObject({ kind: "active", space: unit.space });
      throw new Error("offline");
    });
    await expect(h.manager.syncToCurrentChat()).rejects.toThrow("尚未核验");
    expect(confirmed).not.toHaveBeenCalled();
    const pending = h.persistence.current(h.target().identity)!;
    await h.persistence.forceSync(h.target(), pending.binding, pending.snapshot, () => {});
    expect(confirmed).toHaveBeenCalledOnce();
  });

  it("读取加载候选期间切换聊天，旧结果不能激活或保存", async () => {
    const h = harness();
    const unit = h.sample();
    const binding: ChatSpaceBinding = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: h.target().identity,
    };
    h.metadata.set(h.target().identity, binding);
    const hold = gate();
    const confirmed = vi.fn(async () => {});
    vi.spyOn(h.persistence, "load").mockImplementationOnce(async () => {
      await hold.promise;
      return { snapshot: unit, replacement: { confirmed } };
    });
    const loading = h.manager.syncToCurrentChat();
    h.select("B");
    hold.release();
    expect((await loading).kind).toBe("load-error");
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(confirmed).not.toHaveBeenCalled();
  });
});
