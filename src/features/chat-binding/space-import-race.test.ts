import { describe, expect, it, vi } from "vitest";
import {
  ChatSpaceManager,
  ImportedSpaceSyncError,
  type ChatSpaceManagerPorts,
} from "./chat-space-manager.ts";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import type { MemorySpaceId } from "../memory/index.ts";

describe("imported space binding", () => {
  it.each(["clone", "rename"])(
    "keeps the new chat's binding untouched when switching during %s",
    async (phase) => {
      let chatId = "a";
      const write = vi.fn();
      const rename = vi.fn(async () => {
        if (phase === "rename") chatId = "b";
      });
      const manager = new ChatSpaceManager({
        getChat: () => ({ chatId, characterId: 1, groupId: null, characterName: "A" }),
        bindingStore: { write },
        spaces: { rename },
        backup: {
          cloneSpaceFromUnit: async () => {
            if (phase === "clone") chatId = "b";
            return "imported" as MemorySpaceId;
          },
        },
        createId: () => "id",
      } as unknown as ChatSpaceManagerPorts);
      await expect(manager.importSpace({} as MemorySpaceBackup)).rejects.toMatchObject({
        name: "ImportedSpaceSyncError",
        spaceId: "imported",
        bound: false,
      });
      expect(write).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledTimes(phase === "clone" ? 0 : 1);
    },
  );
  it("keeps a failed clone as an uncommitted failure", async () => {
    const manager = new ChatSpaceManager({
      getChat: () => ({ chatId: "a", characterId: 1, groupId: null, characterName: "A" }),
      backup: {
        cloneSpaceFromUnit: async () => {
          throw new Error("clone failed");
        },
      },
      createId: () => "id",
    } as unknown as ChatSpaceManagerPorts);
    try {
      await manager.importSpace({} as MemorySpaceBackup);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ImportedSpaceSyncError);
      expect(error).toMatchObject({ message: "clone failed" });
    }
  });
});
