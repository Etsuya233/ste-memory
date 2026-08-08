import { describe, expect, it, vi } from "vitest";
import { bootstrap, PLUGIN_DISPLAY_NAME } from "./bootstrap.ts";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 注入 fake start：bootstrap 测试只验证接线，不跑真实 runtime（node 环境无 IndexedDB） */
function bootstrapOptions(overrides: Partial<Parameters<typeof bootstrap>[0]> = {}) {
  return { version: "0.1.0", start: vi.fn(async () => {}), ...overrides };
}

describe("bootstrap（插件初始化）", () => {
  it("ST 环境可用时输出带版本号的初始化日志，状态为 loaded，并启动运行时", () => {
    const log = fakeLog();
    const start = vi.fn(async () => {});
    const status = bootstrap(bootstrapOptions({ getContext: () => ({}), version: "0.1.0", log, start }));

    expect(status).toBe("loaded");
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`${PLUGIN_DISPLAY_NAME}] v0.1.0 已加载`),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), log);
  });

  it("运行时启动失败：记录 error 日志，不影响 loaded 状态", async () => {
    const log = fakeLog();
    const start = vi.fn(async () => {
      throw new Error("boom");
    });
    bootstrap(bootstrapOptions({ getContext: () => ({}), version: "0.1.0", log, start }));
    // 等 catch 链跑完
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(`${PLUGIN_DISPLAY_NAME}] 运行时启动失败`),
      expect.any(Error),
    );
  });

  it("ST 环境不可用时输出警告，状态为 unavailable，不报 loaded，不启动运行时", () => {
    const log = fakeLog();
    const start = vi.fn(async () => {});
    const status = bootstrap(bootstrapOptions({ getContext: () => undefined, version: "0.1.0", log, start }));

    expect(status).toBe("unavailable");
    expect(log.warn).toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
