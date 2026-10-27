import { expect, it, vi } from "vitest";
import { HttpRerankPort } from "./http-rerank.ts";
import {
  parseRerankSettings,
  type RerankConnection,
} from "../../../features/settings/rerank-settings.ts";
import { parseSemanticOptions } from "../../../features/semantic-query/semantic-options.ts";

const connection: RerankConnection = {
  endpoint: "https://rerank.example/v2/rerank",
  model: "rerank-test",
  apiKey: "secret",
  maxInputChars: 8000,
  timeoutSeconds: 5,
};

it("requests every candidate score and restores original document order from response indices", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: -0.2 },
      ],
    }),
  );
  const port = new HttpRerankPort(connection, request);
  expect(await port.rerank("问题", ["第一条", "第二条"], new AbortController().signal)).toEqual([
    -0.2, 0.9,
  ]);
  expect(request.mock.calls[0]![0]).toBe(connection.endpoint);
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
    model: "rerank-test",
    query: "问题",
    documents: ["第一条", "第二条"],
    top_n: 2,
  });
  expect(request.mock.calls[0]![1]).toMatchObject({
    credentials: "omit",
    headers: { Authorization: "Bearer secret" },
  });
});

it.each([
  { results: [{ index: 0, relevance_score: 1 }] },
  {
    results: [
      { index: 0, relevance_score: 1 },
      { index: 0, relevance_score: 0 },
    ],
  },
  {
    results: [
      { index: -1, relevance_score: 1 },
      { index: 1, relevance_score: 0 },
    ],
  },
  {
    results: [
      { index: 0, relevance_score: "1" },
      { index: 1, relevance_score: 0 },
    ],
  },
])("rejects incomplete, duplicate or malformed provider results: %j", async (data) => {
  const port = new HttpRerankPort(
    connection,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)),
  );
  await expect(port.rerank("问题", ["A", "B"], new AbortController().signal)).rejects.toThrow(
    "重排服务返回",
  );
});

it("rejects oversized input before sending and exposes HTTP failures", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 503 }));
  const port = new HttpRerankPort({ ...connection, maxInputChars: 2 }, request);
  await expect(port.rerank("查询", ["超长文本"], new AbortController().signal)).rejects.toThrow(
    "字符上限",
  );
  expect(request).not.toHaveBeenCalled();
  await expect(port.rerank("查询", ["文本"], new AbortController().signal)).rejects.toThrow(
    "HTTP 503",
  );
});

it("defaults old settings to disabled and rejects invalid explicit settings and options", () => {
  expect(parseRerankSettings(undefined)).toEqual({ enabled: false, candidateLimit: 50 });
  expect(() => parseRerankSettings({ enabled: true, candidateLimit: 50 })).toThrow("配置连接");
  expect(() => parseRerankSettings({ enabled: true, candidateLimit: 201, connection })).toThrow(
    "候选数",
  );
  expect(parseSemanticOptions({ scopeRecordIds: ["b", "a", "b"], textFields: ["z", "a"] })).toEqual(
    {
      scopeRecordIds: ["a", "b"],
      textFields: ["z", "a"],
    },
  );
  for (const options of [
    null,
    [],
    { rerank: "false" },
    { candidateLimit: 0 },
    { textFields: [] },
    { extra: true },
  ])
    expect(() => parseSemanticOptions(options)).toThrow();
});
