import { describe, expect, it, vi } from "vitest";
import { bootstrap, PLUGIN_DISPLAY_NAME } from "./bootstrap.ts";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("bootstrap（插件初始化）", () => {
  it("ST 环境可用时输出带版本号的初始化日志，状态为 loaded", () => {
    const log = fakeLog();
    const status = bootstrap({ getContext: () => ({}), version: "0.1.0", log });

    expect(status).toBe("loaded");
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`${PLUGIN_DISPLAY_NAME}] v0.1.0 已加载`),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("ST 环境不可用时输出警告，状态为 unavailable，不报 loaded", () => {
    const log = fakeLog();
    const status = bootstrap({ getContext: () => undefined, version: "0.1.0", log });

    expect(status).toBe("unavailable");
    expect(log.warn).toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});
