/** 云端对象读取结果：内容为文本（云同步文件都是 JSON 文本）。 */
export interface CloudObject {
  readonly body: string;
}

/**
 * 云同步适配器端口（ADR 0022）：I/O 留在平台（浏览器插件用 Cloudflare R2 的
 * S3 兼容接口实现，未来 Google Drive 等适配器实现同一契约），core 只定义契约。
 *
 * - getObject：读取对象；不存在（404）返回 null，不抛错。
 * - putObject：整体覆盖写入（上传即覆盖，幂等）。
 *
 * 键由 core 的 cloud-file.ts 定义（spaces/<spaceId>.json 与 index.json）；
 * 网络/HTTP 错误由实现方抛带人可读信息的 Error。
 */
export interface CloudSyncAdapter {
  getObject(key: string): Promise<CloudObject | null>;
  putObject(
    key: string,
    body: string,
    options?: { readonly contentType?: string },
  ): Promise<void>;
}
