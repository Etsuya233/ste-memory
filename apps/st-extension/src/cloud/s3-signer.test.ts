/// <reference types="node" />
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatAmzDate, signAwsRequestV4 } from "./s3-signer.ts";

/**
 * SigV4 签名测试：签名头结构 + 与 node:crypto 独立实现的签名比对
 * （测试用 Node 内建 crypto，被测代码用 WebCrypto——双实现交叉验证）。
 */

const FIXED_NOW = new Date("2026-08-09T12:34:56.789Z");
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** 独立实现（node:crypto）：与 signAwsRequestV4 相同的算法，不同底层库 */
function expectedSignature(options: {
  method: string;
  url: string;
  body?: string;
  contentType?: string;
  region?: string;
  service?: string;
  now?: Date;
}): string {
  const now = options.now ?? FIXED_NOW;
  const region = options.region ?? "auto";
  const service = options.service ?? "s3";
  const body = options.body ?? "";
  const amzDate = formatAmzDate(now);
  const url = new URL(options.url);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const headers = new Map<string, string>([
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ]);
  if (options.contentType) headers.set("content-type", options.contentType);
  const signedNames = [...headers.keys()].sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers.get(name)}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    options.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const hmac = (key: Buffer, data: string) => createHmac("sha256", key).update(data).digest();
  const kDate = hmac(Buffer.from(`AWS4${CREDENTIALS.secretAccessKey}`), amzDate.slice(0, 8));
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  return hmac(kSigning, stringToSign).toString("hex");
}

describe("formatAmzDate", () => {
  it("ISO 时间 → AWS 规范时间串（去掉分隔符与毫秒）", () => {
    expect(formatAmzDate(FIXED_NOW)).toBe("20260809T123456Z");
  });
});

describe("signAwsRequestV4（R2 SigV4 请求签名）", () => {
  const url = "https://abc123.r2.cloudflarestorage.com/mem-bucket/spaces/space-1.json";

  it("PUT：Authorization 头结构完整（Credential 含日期/区域 auto/服务 s3 + SignedHeaders + Signature）", async () => {
    const headers = await signAwsRequestV4({
      method: "PUT",
      url,
      body: "{\"a\":1}",
      contentType: "application/json",
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    });
    expect(headers["x-amz-date"]).toBe("20260809T123456Z");
    expect(headers["x-amz-content-sha256"]).toHaveLength(64);
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260809\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("PUT：签名与 node:crypto 独立实现一致", async () => {
    const headers = await signAwsRequestV4({
      method: "PUT",
      url,
      body: "{\"a\":1}",
      contentType: "application/json",
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    });
    const signature = headers.authorization.match(/Signature=([0-9a-f]{64})/)?.[1] ?? "";
    expect(signature).toBe(
      expectedSignature({
        method: "PUT",
        url,
        body: "{\"a\":1}",
        contentType: "application/json",
      }),
    );
  });

  it("GET（无 body）：载荷哈希为空串哈希，签名一致", async () => {
    const headers = await signAwsRequestV4({
      method: "GET",
      url,
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    });
    expect(headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("").digest("hex"),
    );
    expect(headers.authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
    const signature = headers.authorization.match(/Signature=([0-9a-f]{64})/)?.[1] ?? "";
    expect(signature).toBe(expectedSignature({ method: "GET", url }));
  });

  it("带查询串：canonical query 排序编码后参与签名", async () => {
    const queryUrl = `${url}?z=1&a=x%20y`;
    const headers = await signAwsRequestV4({
      method: "GET",
      url: queryUrl,
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    });
    const signature = headers.authorization.match(/Signature=([0-9a-f]{64})/)?.[1] ?? "";
    expect(signature).toBe(expectedSignature({ method: "GET", url: queryUrl }));
  });

  it("敏感输入：正文/密钥/时间/方法任一变化 → 签名变化", async () => {
    const base = {
      method: "PUT" as const,
      url,
      body: "{\"a\":1}",
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    };
    const baseSig = (
      await signAwsRequestV4({ ...base, contentType: "application/json" })
    ).authorization;
    const withOtherBody = (
      await signAwsRequestV4({ ...base, body: "{\"a\":2}", contentType: "application/json" })
    ).authorization;
    const withOtherSecret = (
      await signAwsRequestV4({
        ...base,
        credentials: { ...CREDENTIALS, secretAccessKey: "other-secret" },
        contentType: "application/json",
      })
    ).authorization;
    const withOtherTime = (
      await signAwsRequestV4({
        ...base,
        now: new Date("2026-08-10T00:00:00.000Z"),
        contentType: "application/json",
      })
    ).authorization;
    const withOtherMethod = (
      await signAwsRequestV4({ ...base, method: "GET" })
    ).authorization;
    expect(new Set([baseSig, withOtherBody, withOtherSecret, withOtherTime, withOtherMethod]).size).toBe(5);
  });
});
