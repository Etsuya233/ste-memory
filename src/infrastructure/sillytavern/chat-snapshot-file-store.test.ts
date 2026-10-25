import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceBackup } from "../../features/backup/index.ts";
import {
  ChatSnapshotPersistence,
  createChatMirrorFile,
  type ChatFileTarget,
} from "../../features/chat-mirror/index.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import { StChatAdapter, type StContext } from "./chat-adapter.ts";
import { StChatSnapshotFileStore } from "./chat-snapshot-file-store.ts";

function unit(): MemorySpaceBackup {
  return {
    space: {
      id: "s1" as MemorySpaceId,
      name: "空间",
      initializationSource: null,
      createdAt: "2026-10-24T00:00:00Z",
      updatedAt: "2026-10-24T00:00:00Z",
    },
    tables: [],
    fields: [],
    records: [],
    history: [],
    evidence: [],
  };
}
const target: ChatFileTarget = {
  kind: "character",
  identity: "character:0:A",
  chatId: "A",
  avatarUrl: "alice.png",
};

function requests(chat: unknown, saveStatus = 200) {
  const saved: { endpoint: string; body: Record<string, unknown> }[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const endpoint = String(input);
    if (endpoint === "/csrf-token") return Response.json({ token: "csrf" });
    if (endpoint.endsWith("/get")) return Response.json(chat);
    saved.push({ endpoint, body: JSON.parse(init!.body as string) as Record<string, unknown> });
    return Response.json(saveStatus === 200 ? { ok: true } : { error: "integrity" }, {
      status: saveStatus,
    });
  });
  return { request, saved };
}

describe("指定对话快照文件保存", () => {
  it("默认请求保持浏览器原生 fetch 的全局调用绑定", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ token: "csrf" }));
    } as typeof fetch;
    try {
      await expect(new StChatSnapshotFileStore(vi.fn()).read(target)).rejects.toThrow(
        "目标聊天文件不存在",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("从最新文件保留完整正文、头部和其他 metadata，仅替换镜像", async () => {
    const chat = [
      {
        user_name: "u",
        character_name: "a",
        chat_metadata: {
          steMemory: { version: 1, spaceId: "s1" },
          integrity: "slug",
          otherPlugin: { keep: true },
        },
      },
      { name: "a", mes: "最新正文", extra: { x: 1 } },
    ];
    const { request, saved } = requests(chat);
    const afterWrite = vi.fn();
    const file = createChatMirrorFile(unit(), "s1", "now", "test");
    await new StChatSnapshotFileStore(afterWrite, request).write(target, file);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.body).toEqual({
      avatar_url: "alice.png",
      file_name: "A",
      chat: [
        { ...chat[0], chat_metadata: { ...chat[0]!.chat_metadata, steMemoryMirror: file } },
        chat[1],
      ],
    });
    expect(afterWrite).toHaveBeenCalledWith(target, file, undefined);
  });

  it.each([{}, [], [{ mes: "无头部" }], [{ chat_metadata: {} }, { broken: true }]])(
    "坏读 %j 不发起覆盖",
    async (chat) => {
      const { request, saved } = requests(chat);
      const store = new StChatSnapshotFileStore(vi.fn(), request);
      await expect(
        store.write(target, createChatMirrorFile(unit(), "s1", "now", "test")),
      ).rejects.toThrow();
      expect(saved).toEqual([]);
    },
  );

  it("损坏镜像和绑定变化均拒绝覆盖", async () => {
    for (const metadata of [
      { steMemory: { spaceId: "s2" } },
      { steMemory: { spaceId: "s1" }, steMemoryMirror: { version: 999 } },
    ]) {
      const { request, saved } = requests([{ chat_metadata: metadata }]);
      await expect(
        new StChatSnapshotFileStore(vi.fn(), request).write(
          target,
          createChatMirrorFile(unit(), "s1", "now", "test"),
        ),
      ).rejects.toThrow();
      expect(saved).toEqual([]);
    }
  });

  it("群聊使用捕获的聊天 ID，与群组 ID 无关", async () => {
    const { request, saved } = requests([{ chat_metadata: { steMemory: { spaceId: "s1" } } }]);
    await new StChatSnapshotFileStore(vi.fn(), request).write(
      { kind: "group", identity: "group:g:A", chatId: "group-file-A" },
      createChatMirrorFile(unit(), "s1", "now", "test"),
    );
    expect(saved[0]!.endpoint).toBe("/api/chats/group/save");
    expect(saved[0]!.body.id).toBe("group-file-A");
  });

  it("读取网络失败不写文件，保存失败不发布已保存内存状态", async () => {
    const store = new StChatSnapshotFileStore(
      vi.fn(),
      vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    );
    await expect(
      store.write(target, createChatMirrorFile(unit(), "s1", "now", "test")),
    ).rejects.toThrow("offline");
    const { request } = requests([{ chat_metadata: { steMemory: { spaceId: "s1" } } }], 400);
    const afterWrite = vi.fn();
    await expect(
      new StChatSnapshotFileStore(afterWrite, request).write(
        target,
        createChatMirrorFile(unit(), "s1", "now", "test"),
      ),
    ).rejects.toThrow();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("切到 B 后保存捕获的 A，绝不修改 B 的 metadata", async () => {
    let context: StContext = {
      chatId: "A",
      characterId: 0,
      name2: "a",
      characters: [{ avatar: "alice.png" }],
      chatMetadata: {},
    };
    const adapter = new StChatAdapter(() => context);
    const oldTarget = adapter.captureFileTarget()!;
    context = { ...context, chatId: "B", chatMetadata: { other: "B" } };
    const { request, saved } = requests([{ chat_metadata: { steMemory: { spaceId: "s1" } } }]);
    vi.stubGlobal("fetch", request);
    try {
      await adapter.snapshotFileStore.write(
        oldTarget,
        createChatMirrorFile(unit(), "s1", "now", "test"),
      );
      expect(saved[0]!.body.file_name).toBe("A");
      expect(context.chatMetadata).toEqual({ other: "B" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("文件优先加载与显式保存", () => {
  it("立即返回旧对话时，load 等待本实例已排队的保存完成再读文件", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let persisted = createChatMirrorFile(unit(), "s1", "old", "test");
    const store = {
      read: vi.fn(async () => persisted),
      write: vi.fn(async (_target: ChatFileTarget, file: typeof persisted) => {
        await gate;
        persisted = structuredClone(file);
      }),
    };
    const persistence = new ChatSnapshotPersistence(store, () => "test");
    const next = unit();
    Object.assign(next.space, { name: "离开时刚提交的内容" });
    const saving = persistence.save(target, next);
    const loading = persistence.load(target, "s1");
    await Promise.resolve();
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.read).not.toHaveBeenCalled();
    releaseWrite();
    await saving;
    expect((await loading)?.space.name).toBe("离开时刚提交的内容");
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("加载文件快照，不按本地时间竞争；坏镜像与空间不符明确失败", async () => {
    const file = createChatMirrorFile(unit(), "s1", "old", "test");
    const store = { read: vi.fn().mockResolvedValue(file), write: vi.fn() };
    const persistence = new ChatSnapshotPersistence(store, () => "test");
    expect(await persistence.load(target, "s1")).toEqual(unit());
    await expect(persistence.load(target, "other")).rejects.toThrow("绑定不一致");
    store.read.mockResolvedValue({ version: 999 });
    await expect(persistence.load(target, "s1")).rejects.toThrow("损坏");
    store.read.mockResolvedValue(undefined);
    expect(await persistence.load(target, "s1")).toBeUndefined();
  });

  it("保存前捕获独立数据，失败显式展示，下一次可继续保存", async () => {
    const store = {
      read: vi.fn(),
      write: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined),
    };
    const persistence = new ChatSnapshotPersistence(store, () => "test");
    const source = unit();
    const pending = persistence.save(target, source);
    Object.assign(source.space, { name: "已被清理或替换" });
    await expect(pending).rejects.toThrow("offline");
    expect(store.write.mock.calls[0]![1].data.space.name).toBe("空间");
    expect(persistence.getStatus()).toMatchObject({ kind: "failed", error: "offline" });
    await persistence.save(target, unit());
    expect(persistence.getStatus()).toEqual({ kind: "saved", identity: target.identity });
  });
});
