import { describe, expect, it, vi } from "vitest";
import {
  ChatSnapshotPersistence,
  type ChatFileTarget,
  type ChatSnapshotFileStore,
} from "./chat-snapshot-persistence.ts";
import { createChatMirrorFile } from "./chat-mirror-codec.ts";
import { migrateMemorySpaceSnapshot } from "../memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../memory-snapshot/snapshot-test-fixture.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-context.ts";
import type { MemorySpaceId } from "../memory/index.ts";

function harness() {
  const snapshot = migrateMemorySpaceSnapshot({
    version: "legacy-macros",
    snapshot: legacySnapshotFixture(),
  });
  const target: ChatFileTarget = { kind: "group", identity: "A", chatId: "A" };
  const binding: ChatSpaceBinding = {
    version: 2,
    spaceId: snapshot.space.id,
    chatIdentity: target.identity,
  };
  let activeIdentity = target.identity;
  let activeSpace: MemorySpaceId | undefined;
  let metadata: Record<string, unknown> = {
    steMemory: binding,
    steMemoryMirror: createChatMirrorFile(
      snapshot,
      snapshot.space.id,
      snapshot.space.updatedAt,
      "test",
    ),
  };
  let file = structuredClone(metadata);
  const store: ChatSnapshotFileStore = {
    read: vi.fn(async () => metadata.steMemoryMirror),
    restore: vi.fn((owner, mirror, nextBinding) => {
      if (activeIdentity !== owner.identity) {
        throw new Error("聊天已切换");
      }
      metadata = { steMemory: nextBinding, steMemoryMirror: mirror };
    }),
    submit: vi.fn(async (owner, mirror, nextBinding) => {
      store.restore(owner, mirror, nextBinding);
      file = structuredClone(metadata);
    }),
    verify: vi.fn(async () => structuredClone(file)),
  };
  const ledger = {
    read: vi.fn(async (_id: MemorySpaceId): Promise<MemorySpaceBackup["floorLedger"]> => []),
    remove: vi.fn(async (_id: MemorySpaceId) => {}),
    isActive: (owner: ChatFileTarget, id: MemorySpaceId) =>
      activeIdentity === owner.identity && activeSpace === id,
  };
  const persistence = new ChatSnapshotPersistence(store, () => "test", ledger);
  return {
    snapshot,
    target,
    binding,
    store,
    ledger,
    persistence,
    metadata: () => metadata,
    switchChat(identity: string) {
      activeIdentity = identity;
      activeSpace = undefined;
    },
    activate(unit: MemorySpaceBackup) {
      activeSpace = unit.space.id;
    },
    async restore() {
      const loaded = (await persistence.load(target, binding))!;
      activeSpace = loaded.snapshot.space.id;
      if (loaded.replacement) {
        await persistence.replace(target, loaded.snapshot, binding, loaded.replacement.confirmed);
      } else {
        persistence.remember(target, loaded.snapshot, binding);
      }
      return loaded.snapshot;
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

const progress = [{ floor: 7, status: "processed" as const, updatedAt: "now" }];

describe("加载阶段的旧楼层台账迁移", () => {
  it("加载只准备候选，完整文件核验后才清理旧台账", async () => {
    const h = harness();
    h.ledger.read.mockResolvedValue(progress);
    const loaded = (await h.persistence.load(h.target, h.binding))!;
    expect(loaded.snapshot.floorLedger).toEqual(progress);
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.ledger.remove).not.toHaveBeenCalled();
    vi.mocked(h.store.verify).mockImplementationOnce(async () => {
      expect(h.ledger.remove).not.toHaveBeenCalled();
      return structuredClone(h.metadata());
    });
    h.activate(loaded.snapshot);
    await h.persistence.replace(
      h.target,
      loaded.snapshot,
      h.binding,
      loaded.replacement!.confirmed,
    );
    expect(h.ledger.read).toHaveBeenCalledExactlyOnceWith(h.snapshot.space.id);
    expect(h.ledger.remove).toHaveBeenCalledExactlyOnceWith(h.snapshot.space.id);
  });

  it.each(["save", "verify"])("%s 失败保留旧台账与候选，强制同步只重试保存核验", async (phase) => {
    const h = harness();
    h.ledger.read.mockResolvedValue(progress);
    if (phase === "save") {
      vi.mocked(h.store.submit).mockRejectedValueOnce(new Error("offline"));
    } else {
      vi.mocked(h.store.verify).mockResolvedValueOnce({});
    }
    await expect(h.restore()).rejects.toThrow("尚未核验");
    expect(h.ledger.remove).not.toHaveBeenCalled();
    const pending = h.persistence.current(h.target.identity)!;
    expect(pending.snapshot.floorLedger).toEqual(progress);
    expect(await h.persistence.load(h.target, h.binding)).toEqual({ snapshot: pending.snapshot });
    await h.persistence.forceSync(h.target, pending.binding, pending.snapshot, () => {});
    expect(h.ledger.remove).toHaveBeenCalledOnce();
    expect(h.ledger.read).toHaveBeenCalledOnce();
  });

  it("文件已有进度时原样返回，不读取或清理旧表", async () => {
    const h = harness();
    const snapshot = { ...h.snapshot, floorLedger: progress };
    vi.mocked(h.store.read).mockResolvedValue(
      createChatMirrorFile(snapshot, snapshot.space.id, "now", "test"),
    );
    expect(await h.persistence.load(h.target, h.binding)).toEqual({ snapshot });
    expect(h.ledger.read).not.toHaveBeenCalled();
    expect(h.ledger.remove).not.toHaveBeenCalled();
    expect(h.store.submit).not.toHaveBeenCalled();
  });

  it("没有旧台账时保留空进度，不额外保存或清理", async () => {
    const h = harness();
    expect(await h.restore()).toEqual(h.snapshot);
    expect(h.store.submit).not.toHaveBeenCalled();
    expect(h.ledger.remove).not.toHaveBeenCalled();
  });

  it.each([
    { version: 1 as const, spaceId: "space" as MemorySpaceId },
    { version: 2 as const, spaceId: "space" as MemorySpaceId, chatIdentity: "other-file" },
  ])("旧绑定或其他文件绑定不借用本机同空间台账：$version", async (binding) => {
    const h = harness();
    expect(await h.persistence.load(h.target, binding)).toEqual({ snapshot: h.snapshot });
    expect(h.ledger.read).not.toHaveBeenCalled();
    expect(h.ledger.remove).not.toHaveBeenCalled();
  });

  it("缺绑定或快照与绑定不符时不读取旧表", async () => {
    const h = harness();
    expect(await h.persistence.load(h.target)).toEqual({ snapshot: h.snapshot });
    await expect(
      h.persistence.load(h.target, { version: 1, spaceId: "wrong" as MemorySpaceId }),
    ).rejects.toThrow("绑定不一致");
    expect(h.ledger.read).not.toHaveBeenCalled();
  });

  it("核验期间切换聊天保留旧台账，返回原聊天可继续核验与清理", async () => {
    const h = harness();
    h.ledger.read.mockResolvedValue(progress);
    const hold = gate();
    vi.mocked(h.store.verify).mockImplementationOnce(async () => {
      await hold.promise;
      return structuredClone(h.metadata());
    });
    const saving = h.restore();
    const rejected = expect(saving).rejects.toThrow("尚未核验");
    await vi.waitFor(() => expect(h.store.verify).toHaveBeenCalledOnce());
    h.switchChat("B");
    hold.release();
    await rejected;
    expect(h.ledger.remove).not.toHaveBeenCalled();
    h.switchChat("A");
    const pending = h.persistence.current(h.target.identity)!;
    h.persistence.restoreCandidate(h.target.identity);
    h.activate(pending.snapshot);
    await h.persistence.forceSync(h.target, pending.binding, pending.snapshot, () => {});
    expect(h.ledger.remove).toHaveBeenCalledExactlyOnceWith(h.snapshot.space.id);
    expect(h.ledger.read).toHaveBeenCalledOnce();
  });
});
