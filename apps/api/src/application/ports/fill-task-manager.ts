import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FillTaskView } from "./fill-task.ts";
import type { FillTaskSubmitInput } from "../fill-tasks/fill-task-service.ts";

export interface FillTaskManager {
  submit(input: FillTaskSubmitInput): Promise<FillTaskView>;
  /** 当前非终态任务视图（无则 undefined）。 */
  activeTask(memorySpaceId: MemorySpaceId): Promise<FillTaskView | undefined>;
  /** 暂停：running → pause_requested（任务循环在安全点应用为 paused）。 */
  pause(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView>;
  /** 恢复：paused → running。 */
  resume(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView>;
  /** 中止：任意非终态 → cancel_requested（任务循环在安全点置 cancelled）。 */
  cancel(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView>;
}
