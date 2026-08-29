import type { CloudSyncAdapter } from "@ste-memory/core/memory/cloud";
import type { MemoryBackupRepository, MemoryBackupSnapshot } from "@ste-memory/core/memory/export";
import { createCloudIndexFile, createCloudSpaceFile } from "@ste-memory/core/memory/cloud";
import type { MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudSyncCoordinator,
  type CloudSyncStatus,
  type SyncCoordinatorPorts,
} from "./sync-coordinator.ts";
import type { SpaceFingerprint, SyncChangeSource } from "./space-fingerprint.ts";

/**
 * 云同步协调器测试（spec「云同步序列化/索引/冲突（LWW）」测试点）：
 * fake 适配器（内存 Map）+ fake 变更源 + fake 备份库，直接驱动
 * start / kick / syncNow，验证拉取、推送、LWW、防抖、退避与状态发布。
 */

const BASE_TIME = "2026-08-09T00:00:00.000Z";

function fingerprint(updatedAt: string, counts: Partial<SpaceFingerprint> = {}): SpaceFingerprint {
  return { tables: 0, fields: 0, records: 0, history: 0, evidence: 0, updatedAt, ...counts };
}

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

class MemoryAdapter implements CloudSyncAdapter {
  objects = new Map<string, string>();
  /** 预置 PUT 失败：{ key?: 不限; error }；命中才消费 */
  failures: { key?: string; error: Error }[] = [];
  /** 预置 GET 失败（拉取/索引读取路径） */
  getFailures: { key?: string; error: Error }[] = [];
  puts: { key: string; body: string }[] = [];
  gets: string[] = [];

  async getObject(key: string) {
    this.gets.push(key);
    const failure = this.getFailures.find((f) => f.key === undefined || f.key === key);
    if (failure) {
      this.getFailures.splice(this.getFailures.indexOf(failure), 1);
      throw failure.error;
    }
    const body = this.objects.get(key);
    return body === undefined ? null : { body };
  }

  async putObject(key: string, body: string) {
    const failure = this.failures.find((f) => f.key === undefined || f.key === key);
    if (failure) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      throw failure.error;
    }
    this.puts.push({ key, body });
    this.objects.set(key, body);
  }
}

class FakeChangeSource implements SyncChangeSource {
  fingerprints = new Map<string, SpaceFingerprint>();
  async listSpaceIds() {
    return [...this.fingerprints.keys()].sort();
  }
  async fingerprint(spaceId: string) {
    const value = this.fingerprints.get(spaceId);
    if (!value) throw new Error(`未知空间 ${spaceId}`);
    return value;
  }
}

class FakeBackup implements MemoryBackupRepository {
  snapshot: MemoryBackupSnapshot = { spaces: [] };
  restores: MemoryBackupSnapshot[] = [];
  async loadSnapshot() {
    return this.snapshot;
  }
  async restoreSnapshot(snapshot: MemoryBackupSnapshot) {
    this.restores.push(snapshot);
    this.snapshot = snapshot;
  }
  async restoreSpace(_unit: MemorySpaceBackup) {}
  async cloneSpace(_sourceSpaceId: MemorySpaceId) {
    return "cloned" as MemorySpaceId;
  }
  async cloneSpaceFromUnit(_unit: MemorySpaceBackup) {
    return "cloned" as MemorySpaceId;
  }
}

function createHarness(overrides: Partial<SyncCoordinatorPorts> = {}) {
  const adapter = new MemoryAdapter();
  const changes = new FakeChangeSource();
  const backup = new FakeBackup();
  let clock = new Date(BASE_TIME);
  const timers: SyncCoordinatorPorts["timers"] = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const onRestored = vi.fn();
  const coordinator = new CloudSyncCoordinator({
    adapter,
    backup,
    changes,
    isEnabled: () => true,
    appVersion: () => "0.1.0",
    now: () => clock,
    onRestored,
    pollIntervalMs: 60_000, // 测试不靠轮询，防意外触发
    debounceMs: 50,
    retryBaseMs: 10,
    timers,
    ...overrides,
  });
  const advanceClock = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { adapter, changes, backup, coordinator, onRestored, advanceClock };
}

/** 云端预置：多个空间文件 + 对应索引（一次写入，索引含全部条目） */
function seedCloud(
  adapter: MemoryAdapter,
  entries: { spaceId: string; updatedAt: string }[],
): void {
  for (const entry of entries) {
    adapter.objects.set(
      `spaces/${entry.spaceId}.json`,
      JSON.stringify(
        createCloudSpaceFile(
          unit(entry.spaceId, entry.updatedAt),
          entry.spaceId,
          entry.updatedAt,
          "0.1.0",
          BASE_TIME,
        ),
      ),
    );
  }
  adapter.objects.set(
    "index.json",
    JSON.stringify(createCloudIndexFile(entries, "0.1.0", BASE_TIME)),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("空库拉取（本地优先：仅本地为空时）", () => {
  it("空库 + 云端有数据：start 拉取全量并整体恢复，onRestored 触发", async () => {
    const h = createHarness();
    seedCloud(h.adapter, [
      { spaceId: "space-1", updatedAt: BASE_TIME },
      { spaceId: "space-2", updatedAt: BASE_TIME },
    ]);

    await h.coordinator.start();

    expect(h.backup.restores).toHaveLength(1);
    expect(h.backup.restores[0]!.spaces.map((s) => s.space.id)).toEqual(["space-1", "space-2"]);
    expect(h.coordinator.getStatus().kind).toBe("idle");
    expect(h.onRestored).toHaveBeenCalledTimes(1);
  });

  it("空库 + 云端索引未知版本：明确报错（版本不支持），不恢复任何数据", async () => {
    const h = createHarness();
    h.adapter.objects.set(
      "index.json",
      JSON.stringify({ format: "ste-memory-backup", version: 99 }),
    );

    await h.coordinator.start();

    const status = h.coordinator.getStatus() as Extract<CloudSyncStatus, { kind: "error" }>;
    expect(status.kind).toBe("error");
    expect(status.message).toContain("版本不支持");
    expect(h.backup.restores).toHaveLength(0);
  });

  it("空库 + 空间文件未知版本：中止拉取，不产生半恢复", async () => {
    const h = createHarness();
    h.adapter.objects.set(
      "index.json",
      JSON.stringify(
        createCloudIndexFile([{ spaceId: "space-1", updatedAt: BASE_TIME }], "0.1.0", BASE_TIME),
      ),
    );
    h.adapter.objects.set(
      "spaces/space-1.json",
      JSON.stringify({ format: "ste-memory-backup", version: 2 }),
    );

    await h.coordinator.start();

    expect(h.coordinator.getStatus().kind).toBe("error");
    expect(h.backup.restores).toHaveLength(0);
  });

  it("空库 + 空云：拉取成功（无事发生），状态 idle", async () => {
    const h = createHarness();
    await h.coordinator.start();
    expect(h.coordinator.getStatus()).toEqual({
      kind: "idle",
      lastSyncAt: expect.any(String),
    });
    expect(h.backup.restores).toHaveLength(0);
  });

  it("空库已拉取过（空云）：手动 syncNow 仍会重新拉取（另一设备后来上传的数据可被取回）", async () => {
    const h = createHarness();
    await h.coordinator.start(); // 空库 + 空云：拉取一次，无事发生
    expect(h.backup.restores).toHaveLength(0);

    // 另一设备此时上传了数据
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: BASE_TIME }]);
    await h.coordinator.syncNow();

    expect(h.backup.restores).toHaveLength(1);
    expect(h.backup.restores[0]!.spaces.map((s) => s.space.id)).toEqual(["space-1"]);
  });

  it("本地非空：不拉取（本地优先），推送照常", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: "2099-01-01T00:00:00.000Z" }]); // 云端较新

    await h.coordinator.start();

    expect(h.backup.restores).toHaveLength(0);
    // 云端较新 → 推送跳过（不覆盖），无任何上传
    expect(h.adapter.puts).toHaveLength(0);
  });

  it("拉取落地前本地已有数据（竞态）：放弃恢复，不覆盖本地", async () => {
    const h = createHarness();
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: BASE_TIME }]);
    // 拉取进行中本地出现了空间（loadSnapshot 在 restoreSnapshot 前返回非空）
    const originalLoad = h.backup.loadSnapshot.bind(h.backup);
    h.backup.loadSnapshot = async () => ({ spaces: [unit("space-local")] });

    await h.coordinator.start();

    expect(h.backup.restores).toHaveLength(0);
    void originalLoad;
  });
});

describe("变更推送 + 防抖", () => {
  it("启动即推送全部脏空间（空间文件 + 索引文件）", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));

    await h.coordinator.start();

    expect(h.adapter.puts.map((p) => p.key)).toEqual(["spaces/space-1.json", "index.json"]);
    expect(h.coordinator.getStatus().kind).toBe("idle");
    const index = JSON.parse(h.adapter.objects.get("index.json")!) as {
      spaces: { spaceId: string; updatedAt: string }[];
    };
    expect(index.spaces).toEqual([{ spaceId: "space-1", updatedAt: BASE_TIME }]);
  });

  it("变更防抖：窗口内多次 kick 合并为一次推送", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    await h.coordinator.start(); // 首次推送
    h.adapter.puts.length = 0;

    // 两次快速变更（同一防抖窗口）
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T00:00:01.000Z"));
    void h.coordinator.kick();
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T00:00:02.000Z"));
    void h.coordinator.kick();

    await vi.advanceTimersByTimeAsync(60); // 防抖 50ms 到期
    await vi.advanceTimersByTimeAsync(0);

    // 只推送一次（空间 + 索引），内容是最新的变更
    expect(h.adapter.puts).toHaveLength(2);
    const spaceBody = JSON.parse(h.adapter.puts[0]!.body) as { updatedAt: string };
    expect(spaceBody.updatedAt).toBe("2026-08-09T00:00:02.000Z");
  });

  it("无变更：kick 不产生推送，状态 idle", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    await h.coordinator.start();
    h.adapter.puts.length = 0;

    await h.coordinator.kick();
    expect(h.adapter.puts).toHaveLength(0);
    expect(h.coordinator.getStatus().kind).toBe("idle");
  });
});

describe("LWW 冲突（较新版本胜出）", () => {
  it("云端较新：不覆盖本地（跳过上传并视为已同步）", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-09T00:00:10.000Z")] };
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T00:00:10.000Z"));
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: "2026-08-09T01:00:00.000Z" }]); // 云端更新

    await h.coordinator.start();

    expect(h.adapter.puts).toHaveLength(0);
  });

  it("云端相同：跳过上传", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1", BASE_TIME)] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: BASE_TIME }]);

    await h.coordinator.start();

    expect(h.adapter.puts).toHaveLength(0);
  });

  it("本地较新：推送覆盖云端", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1", "2026-08-09T02:00:00.000Z")] };
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T02:00:00.000Z"));
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: "2026-08-09T01:00:00.000Z" }]);

    await h.coordinator.start();

    expect(h.adapter.puts.map((p) => p.key)).toEqual(["spaces/space-1.json", "index.json"]);
    const index = JSON.parse(h.adapter.objects.get("index.json")!) as {
      spaces: { updatedAt: string }[];
    };
    expect(index.spaces[0]!.updatedAt).toBe("2026-08-09T02:00:00.000Z");
  });

  it("推送后本地再次变更：下轮仅推送变更空间，索引合并保留其他空间", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1"), unit("space-2")] };
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T00:00:01.000Z"));
    h.changes.fingerprints.set("space-2", fingerprint("2026-08-09T00:00:02.000Z"));
    await h.coordinator.start();
    expect(h.adapter.puts).toHaveLength(3); // 两个空间 + 索引

    h.adapter.puts.length = 0;
    h.changes.fingerprints.set("space-1", fingerprint("2026-08-09T00:00:03.000Z"));
    await h.coordinator.syncNow();

    expect(h.adapter.puts.map((p) => p.key)).toEqual(["spaces/space-1.json", "index.json"]);
    const index = JSON.parse(h.adapter.objects.get("index.json")!) as {
      spaces: { spaceId: string }[];
    };
    expect(index.spaces.map((s) => s.spaceId)).toEqual(["space-1", "space-2"]);
  });
});

describe("失败处理与重试", () => {
  it("推送失败：状态 error + 退避期内 kick 不再动作；syncNow 立即重试成功", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    h.adapter.failures.push({
      key: "spaces/space-1.json",
      error: new Error("R2 请求失败（HTTP 500）"),
    });

    await h.coordinator.start();
    const status = h.coordinator.getStatus() as Extract<CloudSyncStatus, { kind: "error" }>;
    expect(status.kind).toBe("error");
    expect(status.message).toBe("R2 请求失败（HTTP 500）");

    // 退避期内：kick 不动作（无新请求）
    h.adapter.puts.length = 0;
    await h.coordinator.kick();
    expect(h.adapter.puts).toHaveLength(0);

    // 立即同步：忽略退避，重试成功
    await h.coordinator.syncNow();
    expect(h.coordinator.getStatus().kind).toBe("idle");
    expect(h.adapter.puts.map((p) => p.key)).toEqual(["spaces/space-1.json", "index.json"]);
  });

  it("索引写入失败：空间文件已传但整体未标记，下轮重试补齐（幂等覆盖）", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    h.adapter.failures.push({ key: "index.json", error: new Error("R2 请求失败（HTTP 500）") });

    await h.coordinator.start();
    expect(h.coordinator.getStatus().kind).toBe("error");
    expect(h.adapter.puts.map((p) => p.key)).toEqual(["spaces/space-1.json"]);

    await h.coordinator.syncNow();
    expect(h.coordinator.getStatus().kind).toBe("idle");
    expect(h.adapter.puts.map((p) => p.key)).toEqual([
      "spaces/space-1.json",
      "spaces/space-1.json",
      "index.json",
    ]);
    expect(h.adapter.objects.has("index.json")).toBe(true);
  });

  it("拉取失败（网络）：状态 error，不碰本地", async () => {
    const h = createHarness();
    h.adapter.getFailures.push({
      error: new Error("无法连接 R2（网络错误或 Bucket CORS 未配置）"),
    });

    await h.coordinator.start();

    const status = h.coordinator.getStatus() as Extract<CloudSyncStatus, { kind: "error" }>;
    expect(status.kind).toBe("error");
    expect(status.message).toContain("无法连接 R2");
    expect(h.backup.restores).toHaveLength(0);
  });
});

describe("状态发布与开关", () => {
  it("状态变化经订阅发布（unconfigured → syncing → idle）", async () => {
    const h = createHarness();
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: BASE_TIME }]);
    const kinds: CloudSyncStatus["kind"][] = [];
    h.coordinator.onStatusChange(() => kinds.push(h.coordinator.getStatus().kind));

    await h.coordinator.start();

    expect(kinds).toEqual(["syncing", "idle"]);
  });

  it("停用（isEnabled=false）：状态 unconfigured，不触碰适配器", async () => {
    const h = createHarness({ isEnabled: () => false });
    seedCloud(h.adapter, [{ spaceId: "space-1", updatedAt: BASE_TIME }]);

    await h.coordinator.start();

    expect(h.coordinator.getStatus()).toEqual({ kind: "unconfigured" });
    expect(h.adapter.gets).toHaveLength(0);
    expect(h.adapter.puts).toHaveLength(0);
  });

  it("stop：停止后不再动作", async () => {
    const h = createHarness();
    h.coordinator.stop();
    await h.coordinator.kick();
    await h.coordinator.syncNow();
    expect(h.adapter.gets).toHaveLength(0);
    expect(h.adapter.puts).toHaveLength(0);
  });
});

describe("空间删除与孤立", () => {
  it("本地空间删除后：不再出现在推送中（云端文件保留，删除不传播 v1）", async () => {
    const h = createHarness();
    h.backup.snapshot = { spaces: [unit("space-1"), unit("space-2")] };
    h.changes.fingerprints.set("space-1", fingerprint(BASE_TIME));
    h.changes.fingerprints.set("space-2", fingerprint(BASE_TIME));
    await h.coordinator.start();
    h.adapter.puts.length = 0;

    // 删除 space-2（指纹消失）
    h.changes.fingerprints.delete("space-2");
    await h.coordinator.syncNow();

    expect(h.adapter.puts).toHaveLength(0);
  });
});
