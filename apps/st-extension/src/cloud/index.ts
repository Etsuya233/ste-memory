/** 云同步模块出口（ticket 08）：SigV4 签名 + R2 适配器 + 空间指纹 + 同步协调器。 */
export { R2CloudSyncAdapter } from "./r2-cloud-sync-adapter.ts";
export type { R2CloudSyncAdapterOptions } from "./r2-cloud-sync-adapter.ts";
export { formatAmzDate, signAwsRequestV4 } from "./s3-signer.ts";
export type { SigV4Credentials, SigV4Headers, SigV4SignOptions } from "./s3-signer.ts";
export { fingerprintsEqual } from "./space-fingerprint.ts";
export type { SpaceFingerprint, SyncChangeSource } from "./space-fingerprint.ts";
export { CloudSyncCoordinator } from "./sync-coordinator.ts";
export type { CloudSyncStatus, SyncCoordinatorPorts, SyncTimerPort } from "./sync-coordinator.ts";
