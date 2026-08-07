import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

/**
 * 测试基建冒烟：验证 fake-indexeddb 在 Node 环境可用（ticket 03 的 Dexie
 * repository 测试依赖它）。只测基建本身，不涉及插件实现。
 */
describe("IndexedDB 测试基建（fake-indexeddb）", () => {
  it("indexedDB 可用且能完成一次写入/读取往返", async () => {
    const dbName = "ste-memory-infra-smoke";

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put("value", "key");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const value = await new Promise<string>((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const request = tx.objectStore("kv").get("key");
        request.onsuccess = () => resolve(request.result as string);
        request.onerror = () => reject(request.error);
      });

      expect(value).toBe("value");
    } finally {
      db.close();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    }
  });
});
