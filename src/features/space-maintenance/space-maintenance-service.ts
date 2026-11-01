import type { MemorySpaceId } from "../memory/index.ts";

/** 清除记录入口：取消任务并检查聊天身份，再交给生命周期激活、核验候选与清理辅助数据。 */
export interface SpaceMaintenancePorts {
  /** Memory 端口：删除该空间全部记录派生数据（记录/历史/证据），保留表格结构。 */
  readonly clearRecords: (id: MemorySpaceId) => Promise<boolean>;
  /** 取消该空间进行中的填表任务（interrupted 语义，安全点停止、未提交提案丢弃）。 */
  readonly cancelActiveTask: (id: MemorySpaceId) => Promise<void>;
}

export class RecordsClearCleanupError extends Error {
  readonly memorySpaceId: MemorySpaceId;
  constructor(memorySpaceId: MemorySpaceId, cause: unknown) {
    super(
      `记录已清除，辅助数据清理失败：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RecordsClearCleanupError";
    this.memorySpaceId = memorySpaceId;
  }
}

export class SpaceMaintenanceService {
  readonly #ports: SpaceMaintenancePorts;

  constructor(ports: SpaceMaintenancePorts) {
    this.#ports = ports;
  }

  /**
   * 清除空间记录：删除该空间全部记录派生数据（表格结构与初始化来源保留），并
   * 清空该空间的填表任务与楼层进度台账。空间不存在返回 false。通用日志保留。
   */
  async clearRecords(id: MemorySpaceId, assertContext?: () => void): Promise<boolean> {
    await this.#ports.cancelActiveTask(id);
    assertContext?.();
    return this.#ports.clearRecords(id);
  }
}
