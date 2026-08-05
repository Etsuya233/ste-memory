import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FillTask } from "./fill-task.ts";
import type { FillTaskSubmitInput } from "../fill-tasks/fill-task-service.ts";

export interface FillTaskManager {
  submit(input: FillTaskSubmitInput): Promise<FillTask>;
  /** 当前非终态任务（无则 undefined）；轮询/暂停/恢复等完整状态接口归 ticket 14。 */
  activeTask(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined>;
}
