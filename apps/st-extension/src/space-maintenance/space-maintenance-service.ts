import type { MemorySpaceId } from "@ste-memory/core/memory";

/**
 * 空间维护服务（spec reset-space）：清除空间记录 / 重置空间的宿主编排。
 *
 * - 清除空间记录：取消进行中填表任务 → 删除记录派生数据（core 端口，保留表格
 *   结构）→ 清空该空间的填表任务与楼层进度台账；通用日志保留（审计数据）。
 * - 重置空间：取消进行中填表任务 → 删除全部表格（core 端口，级联字段/记录/
 *   历史/证据）→ 清空填表任务与楼层进度台账 → 按系统表默认定义重新初始化。
 * - 传播语义：两个操作都是普通数据变更，空单元经既有 LWW 机制覆盖 R2 云同步
 *   与对话文件镜像（宿主在操作成功后 kick 同步/镜像/宏）。
 * - 重装失败不回滚已删表格：空间保持无表状态、错误上抛给 UI（可重试），与
 *   「首次创建安装失败即回收空间」不同——重置时空间绑定已存在，不能回收。
 */
export interface SpaceMaintenancePorts {
  /** core 端口：删除该空间全部记录派生数据（记录/历史/证据），保留表格结构。 */
  readonly clearRecords: (id: MemorySpaceId) => Promise<boolean>;
  /** core 端口：删除该空间全部表格（级联字段/记录/历史/证据），空间实体保留。 */
  readonly deleteAllTables: (id: MemorySpaceId) => Promise<boolean>;
  /** 取消该空间进行中的填表任务（interrupted 语义，安全点停止、未提交提案丢弃）。 */
  readonly cancelActiveTask: (id: MemorySpaceId) => Promise<void>;
  /** 删除该空间全部填表任务行（含历史条目）。 */
  readonly clearTasks: (id: MemorySpaceId) => Promise<void>;
  /** 删除该空间全部楼层进度台账行。 */
  readonly clearLedger: (id: MemorySpaceId) => Promise<void>;
  /** 按系统表默认定义重新初始化该空间（8 张系统表；失败上抛）。 */
  readonly installSystemTables: (id: MemorySpaceId) => Promise<void>;
}

export class SpaceMaintenanceService {
  readonly #ports: SpaceMaintenancePorts;

  constructor(ports: SpaceMaintenancePorts) {
    this.#ports = ports;
  }

  /**
   * 清除空间记录：删除该空间全部记录派生数据（表格结构保留），并清空该空间的
   * 填表任务与楼层进度台账。空间不存在返回 false。通用日志保留。
   */
  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    await this.#ports.cancelActiveTask(id);
    const existed = await this.#ports.clearRecords(id);
    if (!existed) return false;
    await this.#ports.clearTasks(id);
    await this.#ports.clearLedger(id);
    return true;
  }

  /**
   * 重置空间：删除该空间全部表格（级联字段/记录/历史/证据），清空填表任务与
   * 楼层进度台账，随后按系统表默认定义重新初始化。空间不存在返回 false。
   * 重装中途失败时：清理半初始化表格后上抛错误，保持「无表状态、可重试」承诺。
   */
  async reset(id: MemorySpaceId): Promise<boolean> {
    await this.#ports.cancelActiveTask(id);
    const existed = await this.#ports.deleteAllTables(id);
    if (!existed) return false;
    await this.#ports.clearTasks(id);
    await this.#ports.clearLedger(id);
    try {
      await this.#ports.installSystemTables(id);
    } catch (error) {
      // 安装器非事务（逐表创建）：中途失败可能留下半初始化表格，清理后重抛——
      // 保证「空间保持无表状态」不变量；清理本身失败不掩盖原始错误。
      await this.#ports.deleteAllTables(id).catch(() => undefined);
      throw error;
    }
    return true;
  }
}
