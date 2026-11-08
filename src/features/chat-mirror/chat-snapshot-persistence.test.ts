import { describe, expect, it, vi } from "vitest";
import {
  ChatSnapshotPersistence,
  type ChatFileTarget,
  type ChatSnapshotFileStore,
} from "./chat-snapshot-persistence.ts";
import { migrateMemorySpaceSnapshot } from "../memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../memory-snapshot/snapshot-test-fixture.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-context.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";

const target: ChatFileTarget = { kind: "group", identity: "A", chatId: "A" };
const unit = () =>
  migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacySnapshotFixture() });
const binding: ChatSpaceBinding = { version: 2, spaceId: unit().space.id, chatIdentity: "A" };
function harness() {
  let active = "A";
  let metadata: Record<string, unknown> = {};
  let file: Record<string, unknown> = {};
  const store: ChatSnapshotFileStore = {
    read: vi.fn(async () => metadata.steMemoryMirror),
    restore: vi.fn((owner, mirror, nextBinding) => {
      if (active !== owner.identity) {
        throw new Error("聊天已切换");
      }
      metadata = structuredClone({ steMemory: nextBinding, steMemoryMirror: mirror });
    }),
    submit: vi.fn(async (target, mirror, binding) => {
      store.restore(target, mirror, binding);
      file = structuredClone(metadata);
    }),
    verify: vi.fn(async () => structuredClone(file)),
  };
  const persistence = new ChatSnapshotPersistence(store, () => "test");
  return {
    persistence,
    store,
    switchChat: (identity: string) => {
      active = identity;
    },
    file: () => file,
    metadata: () => metadata,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("宿主提交与完整文件核验", () => {
  it("普通提交同步发布两个键并即时调用宿主，不读取文件且只表示未核验", async () => {
    const h = harness();
    const saving = h.persistence.saveCommitted(target, binding, unit());
    expect(h.store.restore).toHaveBeenCalledOnce();
    expect(h.store.submit).toHaveBeenCalledOnce();
    await saving;
    expect(h.store.read).not.toHaveBeenCalled();
    expect(h.store.verify).not.toHaveBeenCalled();
    expect(h.persistence.getStatus("A").kind).toBe("submitted");
  });

  it("宿主吞错完成不证明远端保存，强制同步通过回读检测失败", async () => {
    const h = harness();
    vi.mocked(h.store.submit).mockResolvedValue(undefined);
    await h.persistence.saveCommitted(target, binding, unit());
    expect(h.persistence.getStatus("A").kind).toBe("submitted");
    await expect(h.persistence.forceSync(target, binding, unit(), () => {})).rejects.toThrow(
      "不一致",
    );
    expect(h.persistence.getStatus("A").kind).toBe("failed");
  });

  it("强制同步比较完整绑定及镜像，正文相同而绑定不同仍失败", async () => {
    const h = harness();
    vi.mocked(h.store.verify).mockImplementation(async () => ({
      ...h.metadata(),
      steMemory: { ...binding, chatIdentity: "other" },
    }));
    await expect(h.persistence.forceSync(target, binding, unit(), () => {})).rejects.toThrow(
      "不一致",
    );
  });

  it("结构比较忽略对象键序，保留数组和所有快照字段", async () => {
    const h = harness();
    vi.mocked(h.store.verify).mockImplementation(async () => ({
      steMemoryMirror: h.metadata().steMemoryMirror,
      steMemory: { chatIdentity: "A", spaceId: binding.spaceId, version: 2 },
    }));
    await h.persistence.forceSync(target, binding, unit(), () => {});
    expect(h.persistence.getStatus("A").kind).toBe("verified");
  });

  it("核验按实际 JSON 内容比较，可选 undefined 字段消失不会误报失败", async () => {
    const h = harness();
    const snapshot = unit();
    const candidate = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({ ...table, vectorIndex: undefined })),
    };
    vi.mocked(h.store.verify).mockImplementation(async () =>
      JSON.parse(JSON.stringify(h.metadata())),
    );
    await h.persistence.replace(target, candidate, binding);
    expect(h.persistence.getStatus("A").kind).toBe("verified");
  });

  it("核验失败把目标、差异路径与双方值传到界面状态，保留待重试候选", async () => {
    const h = harness();
    vi.mocked(h.store.verify).mockImplementation(async () => {
      const metadata = JSON.parse(JSON.stringify(h.metadata()));
      metadata.steMemoryMirror.data.space.name = "文件里的旧名称";
      return metadata;
    });
    await expect(h.persistence.replace(target, unit(), binding)).rejects.toThrow(
      "chat_metadata.steMemoryMirror.data.space.name",
    );
    expect(h.persistence.getStatus("A")).toMatchObject({
      kind: "failed",
      humanMsg: expect.stringContaining("文件里的旧名称"),
      error: expect.stringContaining("目标对话：A"),
    });
    expect(h.persistence.hasPendingReplacement("A")).toBe(true);
  });

  it.each(["镜像缺失", "null 值", "数组长度", "数组顺序", "额外字段"])(
    "JSON 核验仍拒绝真实差异：%s",
    async (scenario) => {
      const h = harness();
      vi.mocked(h.store.verify).mockImplementation(async () => {
        const metadata = JSON.parse(JSON.stringify(h.metadata()));
        if (scenario === "镜像缺失") {
          delete metadata.steMemoryMirror;
        }
        if (scenario === "null 值") {
          metadata.steMemoryMirror.data.space.name = null;
        }
        if (scenario === "数组长度") {
          metadata.steMemoryMirror.data.tables.pop();
        }
        if (scenario === "数组顺序") {
          metadata.steMemoryMirror.data.floorLedger.reverse();
        }
        if (scenario === "额外字段") {
          metadata.steMemoryMirror.extra = true;
        }
        return metadata;
      });
      const candidate = {
        ...unit(),
        floorLedger: [
          { floor: 0, status: "processed" as const, updatedAt: "now" },
          { floor: 1, status: "error" as const, updatedAt: "now" },
        ],
      };
      await expect(h.persistence.forceSync(target, binding, candidate, () => {})).rejects.toThrow(
        "首个差异：",
      );
      expect(h.persistence.getStatus("A").kind).toBe("failed");
    },
  );

  it("关键候选失败保持输入和清理门控，强制同步重试原候选且仅成功后清理", async () => {
    const h = harness();
    const cleanup = vi.fn(async () => {});
    vi.mocked(h.store.verify).mockRejectedValueOnce(new Error("离线"));
    const candidate = unit();
    await expect(h.persistence.replace(target, candidate, binding, cleanup)).rejects.toThrow(
      "尚未核验",
    );
    h.persistence.release("A");
    expect(h.persistence.current("A")?.snapshot).toEqual(candidate);
    expect(h.persistence.hasPendingReplacement("A")).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    await h.persistence.forceSync(
      target,
      binding,
      { ...candidate, space: { ...candidate.space, name: "不应替换候选" } },
      () => {},
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect((h.file().steMemoryMirror as ChatMirrorFile).data.space.name).toBe(candidate.space.name);
    expect(h.persistence.hasPendingReplacement("A")).toBe(false);
  });

  it("进入宿主保存后允许固定目标只读核验，迟到结果不向新聊天发布", async () => {
    const h = harness();
    const gate = deferred();
    vi.mocked(h.store.submit).mockImplementation(async (target, file, binding) => {
      h.store.restore(target, file, binding);
      await gate.promise;
    });
    vi.mocked(h.store.verify).mockImplementation(async () => h.metadata());
    const cleanup = vi.fn(async () => {});
    const saving = h.persistence.replace(target, unit(), binding, cleanup);
    await vi.waitFor(() => expect(h.store.submit).toHaveBeenCalledOnce());
    h.switchChat("B");
    gate.resolve();
    await saving;
    expect(h.store.restore).toHaveBeenCalledOnce();
    expect(h.store.verify).toHaveBeenCalledWith(target);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("失败后只允许原活动聊天重试写入，普通快照离开即释放", async () => {
    const h = harness();
    vi.mocked(h.store.submit).mockRejectedValueOnce(new Error("离线"));
    await expect(h.persistence.saveCommitted(target, binding, unit())).rejects.toThrow("离线");
    h.switchChat("B");
    await expect(h.persistence.forceSync(target, binding, unit(), () => {})).rejects.toThrow(
      "聊天已切换",
    );
    h.persistence.release("A");
    expect(h.persistence.current("A")).toBeUndefined();
  });
  it("旧原生保存仍在途时，后一个失败不会让强制同步提前越过队列", async () => {
    const h = harness();
    const gate = deferred();
    vi.mocked(h.store.submit)
      .mockImplementationOnce(async (target, file, binding) => {
        h.store.restore(target, file, binding);
        await gate.promise;
      })
      .mockRejectedValueOnce(new Error("第二次失败"));
    const first = h.persistence.saveCommitted(target, binding, unit());
    await expect(h.persistence.saveCommitted(target, binding, unit())).rejects.toThrow(
      "第二次失败",
    );
    const forced = h.persistence.forceSync(target, binding, unit(), () => {});
    await Promise.resolve();
    expect(h.store.submit).toHaveBeenCalledTimes(2);
    gate.resolve();
    await first;
    await forced;
    expect(h.store.submit).toHaveBeenCalledTimes(3);
  });

  it("强制同步排队后离开聊天会明确失败，未开始的调用不发写入或核验", async () => {
    const h = harness();
    const gate = deferred();
    vi.mocked(h.store.submit).mockImplementationOnce(async (target, file, binding) => {
      h.store.restore(target, file, binding);
      await gate.promise;
    });
    const first = h.persistence.saveCommitted(target, binding, unit());
    const forced = h.persistence.forceSync(target, binding, unit(), () => {});
    h.switchChat("B");
    h.persistence.release("A");
    const rejected = expect(forced).rejects.toThrow("已过期");
    gate.resolve();
    await first;
    await rejected;
    expect(h.store.submit).toHaveBeenCalledOnce();
    expect(h.store.verify).not.toHaveBeenCalled();
  });
});
