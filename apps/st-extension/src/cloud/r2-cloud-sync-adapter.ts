import type { CloudObject, CloudSyncAdapter } from "@ste-memory/core/memory/cloud";
import type { R2Settings } from "../settings/plugin-settings.ts";
import { signAwsRequestV4 } from "./s3-signer.ts";

/**
 * Cloudflare R2 适配器（core CloudSyncAdapter 端口，ADR 0022）：
 * S3 兼容接口 + SigV4 签名 + fetch（浏览器直连，bucket 需配置 CORS，见
 * docs/r2-cloud-sync.md）。
 *
 * - endpoint：https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>（路径式）；
 * - 凭证经 getter 每次请求重取（设置面板实时修改立即生效）；
 * - 404 GET → null（对象不存在不是错误）；其余非 2xx 与网络/CORS 失败抛
 *   带人可读中文信息的 Error（协调器展示为同步失败提示）。
 */

export interface R2CloudSyncAdapterOptions {
  /** fetch 实现；缺省 = globalThis.fetch（测试注入 mock） */
  readonly fetchImpl?: typeof fetch;
  /** 时钟；缺省 = new Date（签名时间，测试注入固定值） */
  readonly now?: () => Date;
  /** 单次请求超时（毫秒）；缺省 15s（空库拉取等启动路径有界等待） */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class R2CloudSyncAdapter implements CloudSyncAdapter {
  readonly #getCredentials: () => R2Settings;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(
    getCredentials: () => R2Settings,
    options: R2CloudSyncAdapterOptions = {},
  ) {
    this.#getCredentials = getCredentials;
    this.#fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getObject(key: string): Promise<CloudObject | null> {
    const response = await this.#request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw httpError(response);
    return { body: await readBody(response) };
  }

  async putObject(
    key: string,
    body: string,
    options?: { readonly contentType?: string },
  ): Promise<void> {
    const contentType = options?.contentType ?? "application/json";
    const response = await this.#request("PUT", key, body, contentType);
    if (!response.ok) throw httpError(response);
  }

  /** 构造 R2 对象 URL（路径式 endpoint；bucket 与 key 整体编码——S3 服务端把 %2F
   *  解码回 key 中的斜杠，任何键（含含斜杠的 spaceId）都精确对应同一对象） */
  #endpoint(key: string): string {
    const credentials = this.#getCredentials();
    return `https://${credentials.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(
      credentials.bucket,
    )}/${encodeURIComponent(key)}`;
  }

  async #request(
    method: "GET" | "PUT",
    key: string,
    body?: string,
    contentType?: string,
  ): Promise<Response> {
    const url = this.#endpoint(key);
    const credentials = this.#getCredentials();
    const signed = await signAwsRequestV4({
      method,
      url,
      body,
      contentType,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
      now: this.#now(),
    });
    try {
      return await this.#fetchImpl(url, {
        method,
        headers: {
          ...signed,
          ...(contentType !== undefined ? { "content-type": contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`R2 请求超时（${this.#timeoutMs}ms）：${method} ${key}`, {
          cause: error,
        });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`R2 请求已中止：${method} ${key}`, { cause: error });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接 R2（网络错误或 Bucket CORS 未配置）：${detail}`, {
        cause: error,
      });
    }
  }
}

/** 非 2xx 响应 → 人可读错误（403/404 给针对性提示，其余给状态码） */
function httpError(response: Response): Error {
  const status = response.status;
  if (status === 403) {
    return new Error(
      "R2 访问被拒绝（HTTP 403）：检查 Access Key ID / Secret 与 API 令牌的权限（需对象读写）",
    );
  }
  if (status === 404) {
    return new Error("R2 返回 404：Bucket 不存在或无权访问");
  }
  return new Error(`R2 请求失败（HTTP ${status}）`);
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new Error(
      `读取 R2 响应失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
