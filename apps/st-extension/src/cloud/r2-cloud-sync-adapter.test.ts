import { describe, expect, it, vi } from "vitest";
import { R2CloudSyncAdapter } from "./r2-cloud-sync-adapter.ts";
import type { R2Settings } from "../settings/plugin-settings.ts";

/**
 * R2 适配器测试（mock fetch）：验证请求形状（URL/method/签名头/正文）
 * 与错误处理（404 语义、403/404/5xx 提示、网络与 CORS 失败提示）。
 */

const CREDENTIALS: R2Settings = {
  accountId: "abc123",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  bucket: "mem-bucket",
};

function createHarness(overrides: Partial<R2Settings> = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  const getCredentials = vi.fn(() => ({ ...CREDENTIALS, ...overrides }));
  const adapter = new R2CloudSyncAdapter(getCredentials, {
    fetchImpl: fetchMock,
    now: () => new Date("2026-08-09T12:34:56.789Z"),
  });
  return { adapter, fetchMock, getCredentials };
}

describe("R2CloudSyncAdapter（S3 兼容接口 + SigV4 签名）", () => {
  it("getObject：GET endpoint/bucket/key，带签名头；200 返回正文", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValue(new Response('{"format":"ste-memory-backup"}', { status: 200 }));

    const object = await h.adapter.getObject("spaces/space-1.json");

    expect(object?.body).toBe('{"format":"ste-memory-backup"}');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://abc123.r2.cloudflarestorage.com/mem-bucket/spaces%2Fspace-1.json",
    );
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20260809\/auto\/s3\/aws4_request/);
    expect(headers["x-amz-date"]).toBe("20260809T123456Z");
    expect(headers["x-amz-content-sha256"]).toHaveLength(64);
  });

  it("getObject 404：返回 null（对象不存在不是错误）", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(h.adapter.getObject("index.json")).resolves.toBeNull();
  });

  it("getObject 403：抛「访问被拒绝」提示（检查凭证与令牌权限）", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    await expect(h.adapter.getObject("index.json")).rejects.toThrow("R2 访问被拒绝（HTTP 403）");
  });

  it("getObject 网络失败（TypeError）：抛「无法连接 R2 + CORS 提示」", async () => {
    const h = createHarness();
    h.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(h.adapter.getObject("index.json")).rejects.toThrow(
      "无法连接 R2（网络错误或 Bucket CORS 未配置）",
    );
  });

  it("putObject：PUT + application/json + 正文；凭证 getter 每次请求重取", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await h.adapter.putObject("index.json", "{\"spaces\":[]}");

    expect(h.getCredentials).toHaveBeenCalledTimes(2); // 拼 URL 与签名各一次
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://abc123.r2.cloudflarestorage.com/mem-bucket/index.json");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe("{\"spaces\":[]}");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("putObject 非 2xx：403 针对性提示；404 提示 bucket；500 报状态码", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(h.adapter.putObject("index.json", "x")).rejects.toThrow("访问被拒绝");

    h.fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(h.adapter.putObject("index.json", "x")).rejects.toThrow("Bucket 不存在或无权访问");

    h.fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(h.adapter.putObject("index.json", "x")).rejects.toThrow("R2 请求失败（HTTP 500）");
  });

  it("key 整体 URL 编码（含斜杠的 spaceId 也不破坏对象身份；服务端解码回 key）", async () => {
    const h = createHarness();
    h.fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await h.adapter.getObject("spaces/space/1.json");
    expect(h.fetchMock.mock.calls[0]![0]).toBe(
      "https://abc123.r2.cloudflarestorage.com/mem-bucket/spaces%2Fspace%2F1.json",
    );
  });
});
