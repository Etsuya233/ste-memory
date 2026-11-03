import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-context.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type { ChatFileTarget, LoadedChatSnapshot } from "./chat-snapshot-persistence.ts";

export interface LegacyFloorLedgerMigrationPorts {
  read(spaceId: MemorySpaceId): Promise<MemorySpaceBackup["floorLedger"]>;
  remove(spaceId: MemorySpaceId): Promise<void>;
  isActive(target: ChatFileTarget, spaceId: MemorySpaceId): boolean;
}

/** 加载阶段准备旧台账候选；清理回调仅由既有候选保存流程在文件核验后执行。 */
export async function migrateLegacyFloorLedger(
  target: ChatFileTarget,
  binding: ChatSpaceBinding,
  snapshot: MemorySpaceBackup,
  ports: LegacyFloorLedgerMigrationPorts,
): Promise<LoadedChatSnapshot> {
  if (
    snapshot.floorLedger.length > 0 ||
    binding.version !== 2 ||
    binding.chatIdentity !== target.identity
  ) {
    return { snapshot };
  }
  const ledger = await ports.read(snapshot.space.id);
  if (ledger.length === 0) {
    return { snapshot };
  }
  return {
    snapshot: { ...snapshot, floorLedger: ledger },
    replacement: {
      confirmed: async () => {
        if (!ports.isActive(target, snapshot.space.id)) {
          throw new Error("请回到原聊天后核验旧楼层进度迁移");
        }
        await ports.remove(snapshot.space.id);
      },
    },
  };
}
