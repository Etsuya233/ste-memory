/** 云同步模块出口（ADR 0022）：文件格式 + 编解码纯函数 + LWW 裁决 + 适配器端口。 */
export {
  CLOUD_INDEX_KEY,
  cloudIndexFileSchema,
  cloudSpaceFileKey,
  cloudSpaceFileSchema,
} from "./cloud-file.ts";
export type { CloudIndexEntry, CloudIndexFile, CloudSpaceFile } from "./cloud-file.ts";
export {
  createCloudIndexFile,
  createCloudSpaceFile,
  decodeCloudIndexFile,
  decodeCloudSpaceFile,
  parseCloudIndexFile,
  parseCloudSpaceFile,
  resolveCloudLww,
} from "./cloud-codec.ts";
export type { CloudObject, CloudSyncAdapter } from "./cloud-port.ts";
