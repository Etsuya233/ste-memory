import { describe, expect, it, vi } from "vitest";
import {
  ChatSnapshotPersistence,
  ChatSnapshotReplacementSaveError,
  type ChatFileTarget,
  type ChatSnapshotFileStore,
} from "./chat-snapshot-persistence.ts";
import { migrateMemorySpaceSnapshot } from "../memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../memory-snapshot/snapshot-test-fixture.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-manager.ts";
import type { MemorySpaceId } from "../memory/index.ts";

const target = (identity: string): ChatFileTarget => ({
  kind: "group",
  identity,
  chatId: identity,
});
const binding = (spaceId = "space"): ChatSpaceBinding => ({
  version: 2,
  spaceId: spaceId as MemorySpaceId,
  chatIdentity: "A",
});
const unit = () =>
  migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacySnapshotFixture() });
function harness() {
  const store: ChatSnapshotFileStore = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => {}),
    publish: vi.fn(),
  };
  const persistence = new ChatSnapshotPersistence(store, () => "test");
  persistence.remember(target("A"), unit(), binding());
  return { store, persistence };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("按固定聊天归属保存最新快照", () => {
  it("失败只重试最新已提交内容，读取未保存聊天不读旧磁盘", async () => {
    const { store, persistence } = harness();
    vi.mocked(store.write).mockRejectedValue(new Error("offline"));
    const first = unit();
    await expect(persistence.saveCommitted(target("A"), binding(), first)).rejects.toThrow(
      "offline",
    );
    const latest = { ...first, space: { ...first.space, name: "最新修改" } };
    await expect(persistence.saveCommitted(target("A"), binding(), latest)).rejects.toThrow(
      "offline",
    );
    persistence.release("A");
    expect((await persistence.load(target("A"), "space"))!.space.name).toBe("最新修改");
    expect(store.read).not.toHaveBeenCalled();
    expect(persistence.getStatus("A")).toMatchObject({
      kind: "failed",
      operation: "update",
      humanMsg: expect.stringContaining("已提交"),
    });
    vi.mocked(store.write).mockResolvedValue();
    await persistence.retry("A");
    expect(vi.mocked(store.write).mock.calls.at(-1)![1].data.space.name).toBe("最新修改");
    expect(persistence.hasPendingWrites()).toBe(false);
    expect(persistence.current("A")).toBeUndefined();
  });

  it("A→B→A和同目标迟到结果不覆盖最新metadata", async () => {
    const { store, persistence } = harness();
    const wait = deferred();
    vi.mocked(store.write).mockImplementationOnce(async () => wait.promise);
    const first = persistence.saveCommitted(target("A"), binding(), unit());
    await Promise.resolve();
    persistence.release("A");
    const latest = { ...unit(), space: { ...unit().space, name: "更新" } };
    const second = persistence.saveCommitted(target("A"), binding(), latest);
    await persistence.saveCommitted(
      target("B"),
      { ...binding(), version: 2, chatIdentity: "B" },
      unit(),
    );
    wait.resolve();
    await Promise.all([first, second]);
    const publishedA = vi
      .mocked(store.publish)
      .mock.calls.filter(([owner]) => owner.identity === "A");
    expect(publishedA).toHaveLength(1);
    expect(publishedA[0]![1].data.space.name).toBe("更新");
    expect(vi.mocked(store.write).mock.calls.map(([owner]) => owner.identity)).toEqual([
      "A",
      "B",
      "A",
    ]);
  });

  it("候选(binding,snapshot)同次保存，失败不发布且重试复用同一候选", async () => {
    const { store, persistence } = harness();
    const candidate = {
      ...unit(),
      space: { ...unit().space, id: "candidate" as MemorySpaceId },
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    };
    const activate = vi.fn(async () => {});
    vi.mocked(store.write).mockRejectedValueOnce(new Error("offline"));
    await expect(
      persistence.replace(target("A"), candidate, binding("candidate"), activate),
    ).rejects.toBeInstanceOf(ChatSnapshotReplacementSaveError);
    expect(store.publish).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(persistence.current("A")!.snapshot.space.id).toBe("space");
    await persistence.retry("A");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(store.write)
        .mock.calls.every(([, file, pointer]) => file.spaceId === pointer.spaceId),
    ).toBe(true);
  });

  it("文件已写而激活失败时恢复候选，重试仅激活不再写文件", async () => {
    const { store, persistence } = harness();
    const activate = vi
      .fn()
      .mockRejectedValueOnce(new Error("SQLite加载失败"))
      .mockResolvedValue(undefined);
    const candidate = { ...unit(), space: { ...unit().space, name: "候选" } };
    await expect(persistence.replace(target("A"), candidate, binding(), activate)).rejects.toThrow(
      "已保存",
    );
    persistence.release("A");
    expect((await persistence.load(target("A"), "space"))!.space.name).toBe("候选");
    expect(persistence.hasSavedReplacement("A")).toBe(true);
    await persistence.retry("A");
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("磁盘读取期间出现新提交时，迟到磁盘结果不覆盖pending", async () => {
    const { store, persistence } = harness();
    persistence.release("A");
    const gate = deferred();
    vi.mocked(store.read).mockImplementation(async () => {
      await gate.promise;
      return undefined;
    });
    const reading = persistence.load(target("A"), "space");
    vi.mocked(store.write).mockRejectedValue(new Error("offline"));
    const latest = { ...unit(), space: { ...unit().space, name: "读取期间修改" } };
    await expect(persistence.saveCommitted(target("A"), binding(), latest)).rejects.toThrow(
      "offline",
    );
    gate.resolve();
    expect((await reading)!.space.name).toBe("读取期间修改");
  });

  it("已写文件而批次收口失败只重试收口，后续编辑仍保存最新内容", async () => {
    const { store, persistence } = harness();
    const acknowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValue(undefined);
    await expect(
      persistence.saveCommitted(target("A"), binding(), unit(), acknowledge),
    ).rejects.toThrow("ledger");
    await persistence.retry("A");
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    vi.mocked(store.write).mockRejectedValueOnce(new Error("offline"));
    await expect(
      persistence.saveCommitted(target("A"), binding(), unit(), acknowledge),
    ).rejects.toThrow("offline");
    const latest = { ...unit(), space: { ...unit().space, name: "后续编辑" } };
    await persistence.saveCommitted(target("A"), binding(), latest);
    expect(vi.mocked(store.write).mock.calls.at(-1)![1].data.space.name).toBe("后续编辑");
    expect(acknowledge).toHaveBeenCalledTimes(3);
  });

  it("已保存聊天释放完整快照，idle状态引用稳定", async () => {
    const { store, persistence } = harness();
    expect(persistence.getStatus("unseen")).toBe(persistence.getStatus("unseen"));
    await persistence.saveCommitted(target("A"), binding(), unit());
    persistence.release("A");
    expect(persistence.current("A")).toBeUndefined();
    await persistence.load(target("A"), "space");
    expect(store.read).toHaveBeenCalledTimes(1);
  });
});
