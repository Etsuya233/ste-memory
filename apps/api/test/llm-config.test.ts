import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  LlmConfigError,
  llmConfigInfo,
  loadLlmEnvConfig,
  resolveLlmConfig,
} from "../src/application/chat/llm-config.ts";

describe("loadLlmEnvConfig", () => {
  it("读取三个环境变量，空白视为未配置", () => {
    expect(
      loadLlmEnvConfig({
        OPENAI_BASE_URL: " https://env.example.com/v1 ",
        OPENAI_MODEL: "env-model",
        OPENAI_API_KEY: "env-key",
      }),
    ).toEqual({
      baseUrl: "https://env.example.com/v1",
      model: "env-model",
      apiKey: "env-key",
    });

    expect(loadLlmEnvConfig({ OPENAI_MODEL: "  " })).toEqual({
      baseUrl: null,
      model: null,
      apiKey: null,
    });
  });
});

describe("llmConfigInfo", () => {
  it("只暴露存在性布尔，绝不携带 API Key 值", () => {
    const info = llmConfigInfo({ baseUrl: "https://x/v1", model: "m", apiKey: "secret" });
    expect(info.env.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(info)).not.toContain("secret");
  });
});

describe("resolveLlmConfig", () => {
  it("逐字段 web ?? env：网页配置覆盖，空值回退环境变量", () => {
    const env = { baseUrl: "https://env/v1", model: "env-model", apiKey: "env-key" };
    const web = { baseUrl: "https://web/v1", apiKey: "" };

    expect(resolveLlmConfig(env, web)).toEqual({
      baseUrl: "https://web/v1",
      model: "env-model",
      apiKey: "env-key",
      sources: { baseUrl: "web", model: "env", apiKey: "env" },
    });
  });

  it("全字段来自网页配置", () => {
    const resolved = resolveLlmConfig(
      { baseUrl: "https://env/v1", model: "env-model", apiKey: "env-key" },
      { baseUrl: "https://web/v1", model: "web-model", apiKey: "web-key" },
    );
    expect(resolved).toMatchObject({
      baseUrl: "https://web/v1",
      model: "web-model",
      apiKey: "web-key",
      sources: { baseUrl: "web", model: "web", apiKey: "web" },
    });
  });

  it("baseUrl 双方缺失时回退默认 OpenAI 兼容端点", () => {
    const resolved = resolveLlmConfig(
      { baseUrl: null, model: "m", apiKey: "k" },
      { model: "web-model" },
    );
    expect(resolved.baseUrl).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
    expect(resolved.sources.baseUrl).toBe("default");
  });

  it("model 双方缺失抛 LlmConfigError，提示 OPENAI_MODEL", () => {
    expect(() => resolveLlmConfig({ baseUrl: null, model: null, apiKey: "k" }, {})).toThrow(
      "OPENAI_MODEL",
    );
    expect(() => resolveLlmConfig({ baseUrl: null, model: null, apiKey: "k" }, {})).toThrow(
      LlmConfigError,
    );
  });

  it("apiKey 双方缺失抛 LlmConfigError（field=apiKey），提示 OPENAI_API_KEY", () => {
    try {
      resolveLlmConfig({ baseUrl: null, model: "m", apiKey: null }, {});
      expect.unreachable("应抛 LlmConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmConfigError);
      expect((error as LlmConfigError).field).toBe("apiKey");
      expect((error as LlmConfigError).message).toContain("OPENAI_API_KEY");
    }
  });
});
