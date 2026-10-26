import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "./plugin-settings.ts";
import type { MemoryMacro } from "../memory/index.ts";
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
    validateMacros: vi.fn(async (macros: readonly MemoryMacro[]) => macros),
    getChatScopeMacros: (): readonly MemoryMacro[] => [],
    getChatContext: () => "test-chat",
    refreshVectorIndex: vi.fn(async () => {}),
  };
  return { service: new SettingsService(dependencies), dependencies, observed };
}

describe("SettingsService", () => {
  it("编译分类覆盖输入元数据，新增语义宏停用且已有宏保留显式启用", async () => {
    const { service, dependencies } = harness();
    const existing: MemoryMacro = {
      id: "existing",
      name: "已有语义",
      enabled: true,
      expression: { language: "sql", sql: "SELECT 1", usesSemantic: true },
      output: { format: "json", maxChars: null },
    };
    service.save({ ...service.read(), macros: [existing] });
    const incoming = [
      existing,
      {
        ...existing,
        id: "new",
        name: "新语义",
        expression: {
          language: "sql" as const,
          sql: "SELECT * FROM semantic_scores('events', '[]', 'query')",
          usesSemantic: false,
        },
      },
      {
        ...existing,
        id: "plain",
        name: "普通",
        expression: {
          language: "sql" as const,
          sql: "SELECT 'semantic_scores'",
          usesSemantic: true,
        },
      },
    ];
    dependencies.validateMacros.mockResolvedValueOnce(
      incoming.map((macro) => ({
        ...macro,
        expression: { ...macro.expression, usesSemantic: macro.id !== "plain" },
      })),
    );
    await service.setMacros(incoming);
    expect(dependencies.validateMacros).toHaveBeenCalledWith(incoming, [existing]);
    expect(service.read().macros.map((macro) => [macro.id, macro.enabled])).toEqual([
      ["existing", true],
      ["new", false],
      ["plain", true],
    ]);
    expect(service.read().macros[1]!.expression).toMatchObject({ usesSemantic: true });
    expect(service.read().macros[2]!.expression).toMatchObject({ usesSemantic: false });
  });

  it("对话宏使用编译结果保存，新语义宏关闭且已有语义宏启用状态保留", async () => {
    const { service, dependencies } = harness();
    const macro: MemoryMacro = {
      id: "old",
      name: "已有",
      enabled: true,
      expression: { language: "sql", sql: "SELECT 1" },
      output: { format: "text", maxChars: null },
    };
    dependencies.getChatScopeMacros = () => [macro];
    const incoming = [macro, { ...macro, id: "new", name: "新增" }];
    dependencies.validateMacros.mockResolvedValueOnce(
      incoming.map((item) => ({
        ...item,
        expression: { ...item.expression, usesSemantic: true },
      })),
    );
    await service.setChatScopeMacros(incoming);
    expect(dependencies.writeChatScopeMacros).toHaveBeenCalledWith([
      expect.objectContaining({ id: "old", enabled: true }),
      expect.objectContaining({ id: "new", enabled: false }),
    ]);
  });

  it("异步校验期间切换对话，旧草稿不能保存到新空间", async () => {
    const { service, dependencies } = harness();
    let context = "chat-A";
    dependencies.getChatContext = () => context;
    let finish!: () => void;
    dependencies.validateMacros.mockImplementationOnce(
      () =>
        new Promise<readonly MemoryMacro[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const saving = service.setChatScopeMacros([]);
    context = "chat-B";
    finish();
    await expect(saving).rejects.toThrow("对话已切换");
    expect(dependencies.writeChatScopeMacros).not.toHaveBeenCalled();
  });
  it("旧召回宏名不再被专用功能保留", async () => {
    const { service, dependencies } = harness();
    await service.setMacroName("{{MemoryRecall}}");
    expect(service.read().macroName).toBe("{{MemoryRecall}}");
    expect(dependencies.refreshMemoryMacros).toHaveBeenCalledOnce();
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
    await service.setMacros([]);
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
