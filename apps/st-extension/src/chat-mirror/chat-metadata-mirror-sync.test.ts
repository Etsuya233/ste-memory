import type { ChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import { createChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import type { MemoryBackupRepository, MemoryBackupSnapshot } from "@ste-memory/core/memory/export";
import type { MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceFingerprint, SyncChangeSource } from "../cloud/space-fingerprint.ts";
import type { SyncTimerPort } from "../cloud/sync-coordinator.ts";
import type { ChatSpaceBinding } from "../space-binding/chat-space-manager.ts";
import { StChatAdapter, CHAT_METADATA_MIRROR_KEY, type StContext } from "../st/st-chat-adapter.ts";
import {
  ChatMetadataMirrorSync,
  type ChatMetadataMirrorSyncPorts,
} from "./chat-metadata-mirror-sync.ts";

/**
 * ChatMetadata 镜像同步 seam 测试（ticket 16，spec「数据量小才可行」的运行时
 * 执行面）：fake 变更源 + fake 备份库 + 真实宿主适配器（fake ST context 驱动
 * bindingStore/mirrorStore 读写），直接驱动 start/kick/restoreFromMirror，
 * 验证写回闸门（指纹/防抖/LWW/对话身份）、恢复条件与状态发布。
 */

const BASE_TIME = "2026-08-10T00:00:00.000Z";

function fingerprint(updatedAt: string, counts: Partial<SpaceFingerprint> = {}): SpaceFingerprint {
  return { tables: 0, fields: 0, records: 0, history: 0, evidence: 0, updatedAt, ...counts };
}

const EMPTY_FINGERPRINT = fingerprint("", { tables: 0 });

function unit(spaceId: string, updatedAt: string = BASE_TIME): MemorySpaceBackup {
  return {
    space: {
      id: spaceId as MemorySpaceId,
      name: `空间-${spaceId}`,
      createdAt: BASE_TIME,
      updatedAt,
    },
    tables: [],
    fields: [],
    records: [],
    history: [],
    evidence: [],
  };
}

function binding(spaceId: string): ChatSpaceBinding {
  return { version: 1, spaceId: spaceId as MemorySpaceId };
}

class FakeChangeSource implements SyncChangeSource {
  fingerprints = new Map<string, SpaceFingerprint>();
  async listSpaceIds() {
    return [...this.fingerprints.keys()].sort();
  }
  async fingerprint(spaceId: string) {
    return this.fingerprints.get(spaceId) ?? EMPTY_FINGERPRINT;
  }
}

class FakeBackup implements MemoryBackupRepository {
  snapshot: MemoryBackupSnapshot = { spaces: [] };
  restoredSpaces: MemorySpaceBackup[] = [];
  restoreError: Error | undefined;
  async loadSnapshot() {
    return this.snapshot;
  }
  async restoreSnapshot(snapshot: MemoryBackupSnapshot) {
    this.snapshot = snapshot;
  }
  async restoreSpace(unit: MemorySpaceBackup) {
    if (this.restoreError) throw this.restoreError;
    this.restoredSpaces.push(unit);
  }
  async cloneSpace(_sourceSpaceId: MemorySpaceId) {
    return "cloned" as MemorySpaceId;
  }
  async cloneSpaceFromUnit(_unit: MemorySpaceBackup) {
    return "cloned" as MemorySpaceId;
  }
}

function createHarness(overrides: Partial<ChatMetadataMirrorSyncPorts> = {}) {
  const changes = new FakeChangeSource();
  const backup = new FakeBackup();
  const chatMetadata: Record<string, unknown> = {};
  let currentChatId: string | undefined = "story";
  let currentCharacterId: number | undefined = 3;
  const context: StContext = {
    chatId: "story",
    characterId: 3,
    groupId: null,
    name2: "爱丽丝",
    chat: [],
    chatMetadata,
    saveMetadataDebounced: vi.fn(),
  };
  // 模拟 ST：getContext 每次构造新对象（切对话重取）
  const adapter = new StChatAdapter(() => ({
    ...context,
    chatId: currentChatId,
    characterId: currentCharacterId,
    chatMetadata,
  }));
  // 包装 mirrorStore 显式记录写调用（预置在文件里的镜像不算写）
  const writes: ChatMirrorFile[] = [];
  const hostMirrorStore = adapter.mirrorStore;
  const mirrorStore: ChatMetadataMirrorSyncPorts["mirrorStore"] = {
    read: () => hostMirrorStore.read(),
    write: (file) => {
      writes.push(file);
      hostMirrorStore.write(file);
    },
  };
  let clock = new Date(BASE_TIME);
  const timers: SyncTimerPort = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const sync = new ChatMetadataMirrorSync({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    mirrorStore,
    backup,
    changes,
    isEnabled: () => true,
    includeHistory: () => true,
    appVersion: () => "0.1.0",
    now: () => clock,
    pollIntervalMs: 60_000, // 测试不靠轮询，防意外触发
    debounceMs: 50,
    timers,
    ...overrides,
  });
  const advanceClock = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return {
    changes,
    backup,
    chatMetadata,
    sync,
    advanceClock,
    get writeCalls(): ChatMirrorFile[] {
      return writes;
    },
    switchChat(chatId: string | undefined, characterId?: number | undefined) {
      currentChatId = chatId;
      currentCharacterId = characterId;
    },
  };
}

/** 预置绑定（写绑定指针进 chatMetadata，模拟首次打开后） */
function seedBinding(h: ReturnType<typeof createHarness>, spaceId: string) {
  h.chatMetadata.steMemory = binding(spaceId);
}

async function settle(_h: ReturnType<typeof createHarness>) {
  await vi.advanceTimersByTimeAsync(60); // 防抖 50ms 到期
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ChatMetadataMirrorSync 写回（本地 → 对话文件）", () => {
  it("绑定空间指纹变化：防抖后写镜像（信封含 spaceId/updatedAt/appVersion，data 完整）", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z", { tables: 8 }));
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-10T01:00:00.000Z")] };

    await h.sync.start(); // 轮询评估：检测到变化，武装防抖
    expect(h.writeCalls).toHaveLength(0);
    await settle(h);

    expect(h.writeCalls).toHaveLength(1);
    const file = h.writeCalls[0]!;
    expect(file.format).toBe("ste-memory-chat-mirror");
    expect(file.version).toBe(1);
    expect(file.spaceId).toBe("space-1");
    expect(file.updatedAt).toBe("2026-08-10T01:00:00.000Z");
    expect(file.appVersion).toBe("0.1.0");
    expect(file.data.space.id).toBe("space-1");
  });

  it("指纹未变：不写；再次 kick 也不写", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };

    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(1);

    await h.sync.kick();
    await settle(h);
    expect(h.writeCalls).toHaveLength(1); // 指纹没再变：不重复写
  });

  it("防抖窗口内多次变更合并为一次写回", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.backup.snapshot = { spaces: [unit("space-1")] };

    await h.sync.start();
    // 窗口内连续变更：只武装一次防抖
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    await h.sync.kick();
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:01:00.000Z"));
    await h.sync.kick();
    expect(h.writeCalls).toHaveLength(0);
    await settle(h);

    expect(h.writeCalls).toHaveLength(1);
    expect(h.writeCalls[0]!.updatedAt).toBe("2026-08-10T01:01:00.000Z"); // 合并后取最新
  });

  it("LWW：文件镜像较新 → 不覆盖 + warn；相同 → 不写；本地较新 → 写", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const h = createHarness({ log });

    // 文件里已有镜像（另一台设备写的）
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-10T01:00:00.000Z")] };
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit("space-1", "2026-08-10T02:00:00.000Z"),
      "space-1",
      "2026-08-10T02:00:00.000Z",
      "0.1.0",
    );
    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0); // 文件镜像较新：不覆盖
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("比本地数据新"));

    // 相同：不写也不 warn
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit("space-1", "2026-08-10T01:00:00.000Z"),
      "space-1",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-10T01:00:00.000Z")] };
    await h.sync.kick();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0);

    // 本地较新：写
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T03:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-10T03:00:00.000Z")] };
    await h.sync.kick();
    await settle(h);
    expect(h.writeCalls).toHaveLength(1);
    expect(h.writeCalls[0]!.updatedAt).toBe("2026-08-10T03:00:00.000Z");
  });

  it("文件里已有无法识别的镜像（未来版本/损坏）：原样保留不覆盖 + warn", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const h = createHarness({ log });
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = {
      format: "ste-memory-chat-mirror",
      version: 99,
      spaceId: "space-1",
      updatedAt: "t",
      appVersion: "9.9.9",
      data: {},
    };

    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0);
    expect(h.chatMetadata[CHAT_METADATA_MIRROR_KEY]).toEqual(
      expect.objectContaining({ version: 99 }),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("无法识别"));
  });

  it("includeHistory=false：镜像 data.history 为空（其余保留）", async () => {
    const h = createHarness({ includeHistory: () => false });
    seedBinding(h, "space-1");
    const fullUnit = unit("space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [fullUnit] };

    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(1);
    expect(h.writeCalls[0]!.data.history).toEqual([]);
    expect(h.writeCalls[0]!.data.space).toEqual(fullUnit.space);
  });

  it("临时/未保存对话（chatId 无值）：跳过不写", async () => {
    const h = createHarness();
    h.switchChat(undefined);
    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0);
  });

  it("无绑定 / 绑定无法识别：跳过不写", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const h = createHarness({ log });

    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0); // 无绑定

    h.chatMetadata.steMemory = { version: 99, spaceId: "space-1" }; // 无法识别
    await h.sync.kick();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0); // 绑定无法识别：不镜像
  });

  it("防抖窗口内切走了对话：放弃本轮写回（不把旧对话镜像写进新对话文件）", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };

    await h.sync.start(); // 武装防抖
    h.switchChat("other"); // 防抖期内切对话
    await settle(h);

    expect(h.writeCalls).toHaveLength(0); // 没写进（当前已是新对话的 metadata）
  });

  it("绑定在但空间不在本地库（待镜像恢复）：空指纹不写、不反复触发", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    // 指纹全空（本地无该空间任何行）
    await h.sync.start();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0);
    // 再 kick：不会因为「从未写回」而反复武装防抖
    await h.sync.kick();
    await settle(h);
    expect(h.writeCalls).toHaveLength(0);
  });

  it("写回后状态发布：idle 带上次写回时间与体积；订阅收到通知", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };
    const listener = vi.fn();
    h.sync.onStatusChange(listener);

    await h.sync.start();
    await settle(h);

    const status = h.sync.getStatus();
    expect(status.kind).toBe("idle");
    if (status.kind !== "idle") return;
    expect(status.lastWrittenAt).toBe(BASE_TIME);
    expect(status.sizeBytes).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalled();
  });

  it("isEnabled=false：状态 disabled，不轮询不写", async () => {
    const h = createHarness({ isEnabled: () => false });
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };

    await h.sync.start();
    await settle(h);
    expect(h.sync.getStatus()).toEqual({ kind: "disabled" });
    expect(h.writeCalls).toHaveLength(0);
  });
});

describe("ChatMetadataMirrorSync 恢复（对话文件 → 本地）", () => {
  it("镜像有效且与绑定一致：按空间恢复，返回 true", async () => {
    const h = createHarness();
    const file = createChatMirrorFile(
      unit("space-1", "2026-08-10T01:00:00.000Z"),
      "space-1",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = file;

    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(true);
    expect(h.backup.restoredSpaces).toHaveLength(1);
    expect(h.backup.restoredSpaces[0]!.space.id).toBe("space-1");
  });

  it("镜像 spaceId 与绑定不一致：不恢复（文件自相矛盾时信绑定）", async () => {
    const h = createHarness();
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit("space-other"),
      "space-other",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );
    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(false);
    expect(h.backup.restoredSpaces).toHaveLength(0);
  });

  it("无镜像 / 镜像无法识别：不恢复", async () => {
    const h = createHarness();
    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(false);
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = { format: "ste-memory-chat-mirror", version: 99 };
    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(false);
    expect(h.backup.restoredSpaces).toHaveLength(0);
  });

  it("镜像开关关闭（isEnabled=false）：即使镜像有效也不恢复（写与恢复同门控）", async () => {
    const h = createHarness({ isEnabled: () => false });
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit("space-1"),
      "space-1",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );
    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(false);
    expect(h.backup.restoredSpaces).toHaveLength(0);
  });

  it("恢复失败（物理约束冲突）：返回 false 不抛错", async () => {
    const h = createHarness();
    h.backup.restoreError = new Error("主键冲突");
    h.chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit("space-1"),
      "space-1",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );
    expect(await h.sync.restoreFromMirror(binding("space-1"))).toBe(false);
  });
});

describe("状态订阅", () => {
  it("退订后不再收到通知", async () => {
    const h = createHarness();
    const listener = vi.fn();
    const unsubscribe = h.sync.onStatusChange(listener);
    unsubscribe();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };
    await h.sync.start();
    await settle(h);
    expect(listener).not.toHaveBeenCalled();
  });

  it("相同状态不重复通知", async () => {
    const h = createHarness();
    seedBinding(h, "space-1");
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-10T01:00:00.000Z"));
    h.backup.snapshot = { spaces: [unit("space-1")] };
    const listener = vi.fn();
    h.sync.onStatusChange(listener);

    await h.sync.start();
    await settle(h);
    const callsAfterWrite = listener.mock.calls.length;
    await h.sync.kick(); // 无变化：状态不变，不通知
    await settle(h);
    expect(listener.mock.calls.length).toBe(callsAfterWrite);
  });
});
