import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../features/settings/plugin-settings.ts";
import { SettingsService } from "../../../features/settings/settings-service.ts";
import { normalizedAgentConnection, persistSettingsEdit } from "./connection-settings-model.ts";

function harness() {
  let current = structuredClone(DEFAULT_SETTINGS);
  const refreshVectorIndex = vi.fn(async () => {});
  const settings = new SettingsService({
    store: {
      read: () => current,
      write: (next) => {
        current = next;
      },
    },
    syncToCurrentChat: async () => {},
    refreshMemoryMacros: async () => {},
    refreshAgentMacros: async () => {},
    refreshMirror: async () => {},
    refreshVectorIndex,
    writeChatScopeMacros: () => {},
    validateMacros: async (macros) => macros,
    getChatScopeMacros: () => [],
    getChatContext: () => "chat",
  });
  return {
    services: {
      settings,
      onChanged: vi.fn(async () => {}),
      testAgentConnection: vi.fn(async () => ({ ok: true as const, models: [] })),
      version: "test",
    },
    refreshVectorIndex,
  };
}

describe("connection setting persistence", () => {
  it("reports embedding settings as committed when its subsequent vector refresh fails", async () => {
    const { services, refreshVectorIndex } = harness();
    refreshVectorIndex.mockRejectedValueOnce(new Error("index unavailable"));
    const connection = {
      baseUrl: "https://embedding.example/v1",
      apiKey: "",
      model: "embed",
      maxInputChars: 8000,
      timeoutSeconds: 120,
    };
    const result = await persistSettingsEdit(
      services,
      () => services.settings.setEmbeddingConnection(connection),
      (settings) => settings.embeddingConnection?.model === "embed",
    );
    expect(result).toMatchObject({
      saved: true,
      error: "index unavailable",
      settings: { embeddingConnection: connection },
    });
    expect(services.onChanged).toHaveBeenCalledOnce();
  });

  it("retains a failed write result while still notifying the host", async () => {
    const { services } = harness();
    const result = await persistSettingsEdit(
      services,
      () => {
        throw new Error("store unavailable");
      },
      (settings) => settings.rerank.enabled,
    );
    expect(result).toMatchObject({
      saved: false,
      error: "store unavailable",
      settings: { rerank: { enabled: false } },
    });
    expect(services.onChanged).toHaveBeenCalledOnce();
  });

  it("preserves both service and host refresh errors after a committed edit", async () => {
    const { services, refreshVectorIndex } = harness();
    refreshVectorIndex.mockRejectedValueOnce(new Error("vector refresh"));
    services.onChanged.mockRejectedValueOnce(new Error("host refresh"));
    const result = await persistSettingsEdit(
      services,
      () => services.settings.setEmbeddingConnection(undefined),
      (settings) => settings.embeddingConnection === undefined,
    );
    expect(result).toMatchObject({ saved: true, error: "vector refresh；host refresh" });
  });
});

describe("agent connection save boundary", () => {
  const connection = {
    id: "new",
    name: " Independent ",
    baseUrl: " https://api.example/v1/chat/completions/ ",
    apiKey: " key ",
    model: " model ",
    customHeaders: { "X-Route": "private" },
  };
  it("normalizes a pasted completion URL and keeps request headers", () => {
    expect(normalizedAgentConnection(connection)).toEqual({
      ...connection,
      name: "Independent",
      baseUrl: "https://api.example/v1",
      apiKey: "key",
      model: "model",
    });
  });
  it.each([
    "file:///private",
    "https://name:password@api.example",
    "https://api.example?key=secret",
  ])("rejects unsafe or ambiguous endpoint %s", (baseUrl) => {
    expect(() => normalizedAgentConnection({ ...connection, baseUrl })).toThrow("HTTP / HTTPS");
  });
  it("uses actual request header validation before saving", () => {
    expect(() =>
      normalizedAgentConnection({
        ...connection,
        customHeaders: { "X-Route": "a", "x-route": "b" },
      }),
    ).toThrow("请求头名称重复");
  });
});
