/**
 * 定时器端口：轮询服务（记忆宏 / Agent 预设宏 / 聊天文件镜像）在测试中注入
 * 假定时器，运行期缺省 = globalThis。
 */
export interface TimerPort {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultTimers: TimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
