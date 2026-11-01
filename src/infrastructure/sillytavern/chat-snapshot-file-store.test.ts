import { describe, expect, it, vi } from "vitest";
import { StChatSnapshotFileStore } from "./chat-snapshot-file-store.ts";
import { createChatMirrorFile } from "../../features/chat-mirror/chat-mirror-codec.ts";
import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../../features/memory-snapshot/snapshot-test-fixture.ts";
import type { ChatFileTarget } from "../../features/chat-mirror/chat-snapshot-persistence.ts";

const target: ChatFileTarget = {
  kind: "character",
  identity: "char:1:A",
  chatId: "A",
  avatarUrl: "a.png",
};
function harness() {
  let active = target.identity;
  const metadata: Record<string, unknown> = {};
  const save = vi.fn(async () => {});
  const request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify([{ chat_metadata: metadata }])),
  );
  const store = new StChatSnapshotFileStore(
    {
      assertActive: (owner) => {
        if (owner.identity !== active) {
          throw new Error("聊天已切换");
        }
      },
      metadata: () => metadata,
      saveMetadata: save,
      headers: () => ({ "Content-Type": "application/json", "X-CSRF-Token": "host" }),
    },
    request,
  );
  const snapshot = migrateMemorySpaceSnapshot({
    version: "legacy-macros",
    snapshot: legacySnapshotFixture(),
  });
  const binding = {
    version: 2 as const,
    spaceId: snapshot.space.id,
    chatIdentity: target.identity,
  };
  const file = createChatMirrorFile(snapshot, snapshot.space.id, snapshot.space.updatedAt, "test");
  return {
    store,
    request,
    save,
    metadata,
    binding,
    file,
    switchChat: () => {
      active = "char:1:B";
    },
  };
}

describe("ST 原生元数据保存", () => {
  it("加载使用已载metadata，保存只调用原生接口且保留其他键", async () => {
    const h = harness();
    h.metadata.other = "宿主数据";
    h.store.restore(target, h.file, h.binding);
    expect(await h.store.read(target)).toEqual(h.file);
    await h.store.submit(target, h.file, h.binding);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.metadata).toEqual({
      other: "宿主数据",
      steMemory: h.binding,
      steMemoryMirror: h.file,
    });
  });

  it("固定目标核验只发get接口并复用宿主请求头，不获取第二份CSRF", async () => {
    const h = harness();
    h.store.restore(target, h.file, h.binding);
    h.switchChat();
    expect(await h.store.verify(target)).toEqual({ steMemory: h.binding, steMemoryMirror: h.file });
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "/api/chats/get",
      expect.objectContaining({
        body: JSON.stringify({ avatar_url: "a.png", file_name: "A" }),
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "host" },
      }),
    );
  });

  it("切聊后禁止发布和写入旧目标，固定目标核验仍可只读", async () => {
    const h = harness();
    h.switchChat();
    expect(() => h.store.restore(target, h.file, h.binding)).toThrow("聊天已切换");
    expect(() => h.store.submit(target, h.file, h.binding)).toThrow("聊天已切换");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("群聊核验沿用group/get目标协议，缺文件明确失败", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(new Response("[]"));
    await expect(
      h.store.verify({ kind: "group", identity: "group:g", chatId: "g" }),
    ).rejects.toThrow("缺失");
    expect(h.request).toHaveBeenCalledWith(
      "/api/chats/group/get",
      expect.objectContaining({ body: JSON.stringify({ id: "g" }) }),
    );
  });
});
