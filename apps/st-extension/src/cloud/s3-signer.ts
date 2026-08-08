/**
 * AWS Signature Version 4 纯函数签名（Cloudflare R2 S3 兼容接口，spec 决策 5）。
 *
 * 浏览器插件无法用 AWS SDK（体积），这里手写 SigV4：canonical request →
 * string to sign → HMAC-SHA256 签名链 → Authorization 头。WebCrypto
 * （crypto.subtle，浏览器与 Node 均可用），无任何外部依赖。
 *
 * R2 约定：endpoint = https://<accountId>.r2.cloudflarestorage.com，
 * 区域固定 "auto"（R2 忽略但 SigV4 必填），service = "s3"。
 *
 * 签名的头（host / x-amz-content-sha256 / x-amz-date / content-type）与
 * fetch 实际发送的头必须一致；本模块返回除 host（fetch 自动设置）外的
 * 三个头，content-type 由调用方按需补发（签名时已计入）。
 */

/** R2 API 令牌凭证（Cloudflare 控制台 R2 → Manage R2 API Tokens 生成） */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4SignOptions {
  readonly method: string;
  /** 完整 URL（endpoint + bucket + key），pathname 保持已编码的路径段 */
  readonly url: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly credentials: SigV4Credentials;
  /** 签名区域；R2 固定 auto（默认） */
  readonly region?: string;
  /** 签名服务；R2 固定 s3（默认） */
  readonly service?: string;
  /** 时钟；缺省 = new Date（测试注入固定值） */
  readonly now?: Date;
}

/** 需要随请求发出的签名头（host 由 fetch 自动设置，不在其中） */
export interface SigV4Headers {
  readonly authorization: string;
  readonly "x-amz-date": string;
  readonly "x-amz-content-sha256": string;
}

const encoder = new TextEncoder();

/**
 * WebCrypto 句柄：crypto.subtle 只在安全上下文可用（https / localhost；
 * TauriTavern 的 tauri.localhost 属安全上下文）。不可用时抛清晰错误——
 * R2 签名依赖 HMAC-SHA256，无纯 JS 回退（见 docs/r2-cloud-sync.md §排查）。
 */
function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "当前环境不支持 WebCrypto（非安全上下文），R2 云同步不可用；请通过 https 或 localhost 访问",
    );
  }
  return subtle;
}

/** ISO 时间 → AWS 规范时间串：2026-08-09T12:34:56.789Z → 20260809T123456Z */
export function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await subtleCrypto().digest("SHA-256", encoder.encode(data));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = subtleCrypto();
  const cryptoKey = await subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return new Uint8Array(signature);
}

/** SigV4 签名密钥链：kDate → kRegion → kService → kSigning */
async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/**
 * 对一次请求做 SigV4 签名，返回需要随 fetch 发出的三个头。
 * 纯函数（除 crypto.subtle 外无副作用），请求形状可独立测试。
 */
export async function signAwsRequestV4(options: SigV4SignOptions): Promise<SigV4Headers> {
  const now = options.now ?? new Date();
  const region = options.region ?? "auto";
  const service = options.service ?? "s3";
  const body = options.body ?? "";
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(options.url);

  const payloadHash = await sha256Hex(body);
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

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    options.credentials.secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
}
