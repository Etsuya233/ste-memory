import type { MemorySpaceId } from "../memory/index.ts";

/**
 * 空间维护服务：清除空间记录的宿主编排（spec reset-space；表格预设之后本服务
 * 只保留「清除记录」——按预设重建统一走 features/table-presets 的应用流程）。
 *
 * - 清除空间记录：取消进行中填表任务 → 删除记录派生数据（Memory 端口，保留表格
 *   结构与初始化来源）→ 清空该空间的填表任务与楼层进度台账；通用日志保留。
 * - 传播语义：普通数据变更，空单元经既有 LWW 机制覆盖对话文件镜像
 *   （宿主在操作成功后 kick 镜像/宏）。
 */
export interface SpaceMaintenancePorts {
  /** Memory 端口：删除该空间全部记录派生数据（记录/历史/证据），保留表格结构。 */
  readonly clearRecords: (id: MemorySpaceId) => Promise<boolean>;
  /** 取消该空间进行中的填表任务（interrupted 语义，安全点停止、未提交提案丢弃）。 */
  readonly cancelActiveTask: (id: MemorySpaceId) => Promise<void>;
  /** 删除该空间全部填表任务行（含历史条目）。 */
  readonly clearTasks: (id: MemorySpaceId) => Promise<void>;
  /** 删除该空间全部楼层进度台账行。 */
  readonly clearLedger: (id: MemorySpaceId) => Promise<void>;
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
  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    await this.#ports.cancelActiveTask(id);
    const existed = await this.#ports.clearRecords(id);
    if (!existed) return false;
    await this.#ports.clearTasks(id);
    await this.#ports.clearLedger(id);
    return true;
  }
}
