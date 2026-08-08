/**
 * 空间变更指纹（纯逻辑 seam 的一部分）：云同步「哪些空间变了」的判定依据。
 *
 * core 服务只更新变更实体自身的 updatedAt（记录变更不更新空间行），因此
 * 「空间 updatedAt」不能单独作为变更信号。指纹 = 五张子表的行数 + 全空间
 * 最大 updatedAt（空间/表格/字段/记录/历史；证据无时间戳）——任何变更
 * （增删改，含整库导入恢复）都会改变行数或最大时间，指纹相同即内容等价，
 * 跳过推送。
 */

export interface SpaceFingerprint {
  readonly tables: number;
  readonly fields: number;
  readonly records: number;
  readonly history: number;
  readonly evidence: number;
  /** 全空间最近变更时间（LWW 键）：空间/表格/字段/记录/历史的最大 updatedAt；无任何行时为空串 */
  readonly updatedAt: string;
}

/** 指纹相等 = 内容等价（跳过推送）。 */
export function fingerprintsEqual(left: SpaceFingerprint, right: SpaceFingerprint): boolean {
  return (
    left.tables === right.tables &&
    left.fields === right.fields &&
    left.records === right.records &&
    left.history === right.history &&
    left.evidence === right.evidence &&
    left.updatedAt === right.updatedAt
  );
}

/**
 * 变更来源端口：协调器只依赖空间 id 清单与逐空间指纹（宿主 = Dexie 实现，
 * 测试注入 fake）。读操作足够轻，可每 2s 轮询。
 */
export interface SyncChangeSource {
  listSpaceIds(): Promise<readonly string[]>;
  fingerprint(spaceId: string): Promise<SpaceFingerprint>;
}
