import { configDefaults, defineConfig } from "vitest/config";

/**
 * 全仓 vitest 配置：默认排除外部参考资源目录。
 *
 * `tmp/` 与 `.worktrees/` 存放外部参考材料（SillyTavern 源码、样例插件源码等，
 * 见 AGENTS.md），其自带测试套件不依赖本 workspace 的模块图、部分还依赖真实
 * LLM 网络调用——零配置 glob 会把它们收进来导致大面积无关失败（ticket 04 实测
 * 90 个失败文件几乎全部来自 tmp/）。排除后 `pnpm test` 即等价于此前手动
 * `--exclude 'tmp/**' --exclude '.worktrees/**'` 的跑法。
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tmp/**", ".worktrees/**"],
    // 全仓并行时 16 fork 风暴造成内存/transform 抖动：api 集成测试与 esbuild 构建链
    // 测试出现漂移式超时（放宽到 20s/30s 仍不够）。实测限并发到 4 后 124/124 全绿，
    // 墙钟与 16 worker 持平（~176s），故以 maxWorkers 治本。
    maxWorkers: 4,
    // 兜底：负载异常时避免被 vitest 默认 5s 超时误报（默认 testTimeout = 5000ms）。
    testTimeout: 20_000,
  },
});
