import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "./plugin-settings.ts";
import { SettingsService } from "./settings-service.ts";

function harness() {
  let settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  const observed: PluginSettings[] = [];
  const refresh = () => {
    observed.push(settings);
    return Promise.resolve();
  };
  const dependencies = {
    store: {
      read: () => settings,
      write: (next: PluginSettings) => {
        settings = next;
      },
    },
    syncToCurrentChat: vi.fn(refresh),
    refreshMemoryMacros: vi.fn(refresh),
    refreshAgentMacros: vi.fn(refresh),
    refreshMirror: vi.fn(refresh),
    writeChatScopeMacros: vi.fn(),
    refreshVectorIndex: vi.fn(async () => {}),
  };
  return { service: new SettingsService(dependencies), dependencies, observed };
}

describe("SettingsService", () => {
  it("拒绝覆盖自动召回保留宏，大小写与 ST 注册规则一致", async () => {
    const { service, dependencies } = harness();
    const before = service.read().macroName;
    await expect(service.setMacroName("{{MemoryRecall}}")).rejects.toThrow("保留宏名");
    expect(service.read().macroName).toBe(before);
    expect(dependencies.refreshMemoryMacros).not.toHaveBeenCalled();
  });
  it("保存独立向量连接后刷新索引，非法配置不落库", async () => {
    const { service, dependencies } = harness();
    const connection = {
      baseUrl: "http://localhost:8080/v1",
      apiKey: "",
      model: "embedding",
      maxInputChars: 8000,
      timeoutSeconds: 120,
    };
    await service.setEmbeddingConnection(connection);
    expect(service.read().embeddingConnection).toEqual(connection);
    expect(dependencies.refreshVectorIndex).toHaveBeenCalledOnce();
    await expect(
      service.setEmbeddingConnection({ ...connection, timeoutSeconds: 0 }),
    ).rejects.toThrow("超时");
    expect(service.read().embeddingConnection).toEqual(connection);
  });
  it("启用先保存，再同步对话和刷新宏与镜像", async () => {
    const { service, dependencies, observed } = harness();
    service.save({ ...service.read(), enabled: false });
    await service.setPluginEnabled(true);
    expect(dependencies.syncToCurrentChat).toHaveBeenCalledOnce();
    expect(dependencies.refreshMemoryMacros).toHaveBeenCalledOnce();
    expect(dependencies.refreshAgentMacros).toHaveBeenCalledOnce();
    expect(dependencies.refreshMirror).toHaveBeenCalledOnce();
    expect(observed).toHaveLength(4);
    expect(observed.every((settings) => settings.enabled)).toBe(true);
  });

  it("停用不创建空间，两个宏和镜像立即读取停用状态", async () => {
    const { service, dependencies, observed } = harness();
    await service.setPluginEnabled(false);
    expect(dependencies.syncToCurrentChat).not.toHaveBeenCalled();
    expect(observed).toHaveLength(3);
    expect(observed.every((settings) => !settings.enabled)).toBe(true);
  });

  it("镜像设置只刷新镜像，并保留镜像其他字段", async () => {
    const { service, dependencies, observed } = harness();
    await service.setMirrorEnabled(false);
    await service.setMirrorHistoryIncluded(false);
    expect(service.read().mirror).toEqual({ enabled: false, includeHistory: false });
    expect(observed[0]!.mirror).toEqual({ enabled: false, includeHistory: true });
    expect(dependencies.refreshMirror).toHaveBeenCalledTimes(2);
    expect(dependencies.refreshMemoryMacros).not.toHaveBeenCalled();
  });

  it("连续修改宏设置读取最新值，保留其他设置", async () => {
    const { service, dependencies } = harness();
    service.setEntryPlacement("wand");
    await service.setMacroName("{{memory}}");
    await service.setMacroLimit(4000);
    await service.setMemoryViews([]);
    expect(service.read()).toMatchObject({
      macroName: "{{memory}}",
      macroLimit: 4000,
      entryPlacement: "wand",
    });
    expect(dependencies.refreshMemoryMacros).toHaveBeenCalledTimes(3);
    expect(dependencies.refreshAgentMacros).not.toHaveBeenCalled();
  });

  it("对话宏写入聊天存储后刷新，不改全局设置", async () => {
    const { service, dependencies } = harness();
    const before = service.read();
    await service.setChatScopeMacros([]);
    expect(dependencies.writeChatScopeMacros).toHaveBeenCalledWith([]);
    expect(dependencies.refreshMemoryMacros).toHaveBeenCalledOnce();
    expect(service.read()).toBe(before);
  });

  it("刷新失败向调用方报告，已保存的设置保持可读", async () => {
    const { service, dependencies } = harness();
    dependencies.refreshMemoryMacros.mockRejectedValueOnce(new Error("宏刷新失败"));
    await expect(service.setMacroName("{{new}}")).rejects.toThrow("宏刷新失败");
    expect(service.read().macroName).toBe("{{new}}");
  });
});
