# 对话文件镜像：随聊天文件同步记忆快照（ticket 16）

在 R2 云同步（ticket 08）之外增加一条**单通道**同步路径：把当前对话记忆空间的
完整快照（结构 + 记录 + 修订历史 + 证据）写进 `chat_metadata.steMemoryMirror`
（独立键），随聊天文件走——文件同步到哪，记忆就跟到哪。**不做与 R2 的跨服务
协调**：两条通道各自「本地优先」，天然组合。

## 动机与边界

- R2 需要在新设备上重新配置凭证才能拉取；镜像不依赖任何云配置，聊天文件本身
  就是传输载体（文件如何跨设备同步由用户自己的方式负责）。
- 镜像只作**恢复源**：本地空间缺失（换设备/本地库被清）时恢复，绝不覆盖本地
  已有数据。双向 LWW：本地较新才写回文件；文件较新只 warn 不动。
- 已知限制（v1 接受）：写回失败无失败信号（ST 无 CHAT_SAVED 事件，状态只展示
  上次写回时间）；本地删除不传播（打开时镜像会复活，与 R2 同源）；本地空间
  存在但文件镜像较新（另一设备数据未落地）只 warn。

## 格式（core `src/memory/chat-mirror/`，与备份单元完全同构）

- 信封：`{ format: "ste-memory-chat-mirror", version: 1, spaceId, updatedAt, appVersion, data }`；
  `updatedAt` = 空间指纹的 LWW 键。
- `data` = **完整 `MemorySpaceBackup`**（space/tables/fields/records/history/
  evidence 六要素，与备份/R2 空间文件 data 同构）——结构校验复用
  `memorySpaceBackupSchema`、完整性校验复用 `validateSpaceBackupUnit`，零裁剪。
- 与云同步文件语义不同：**未知版本/损坏一律返回 null 由调用方忽略**（镜像坏了
  不能打断打开流程，原样保留不覆盖——与绑定 unrecognized 同守则）。
- 设置项「镜像包含修订历史」关闭时 `data.history` 裁为空数组（体积主要来源）。

## 同步模型（插件纯逻辑 `src/chat-mirror/chat-metadata-mirror-sync.ts`）

- **写回（本地 → 文件）**：轮询当前对话绑定空间的指纹（复用
  `DexieSyncChangeSource`，2s）→ 变化后 3s 防抖合并 → LWW（本地较新才写）→
  宿主写 `chatMetadata` + `saveMetadataDebounced()`（ST 1s 防抖后全量保存聊天
  文件）。文件身份跟踪：按对话身份（chatId + 角色/群聊）记录上次写回，复制的
  对话文件共享同一空间也不会互相漏写。
- **恢复（文件 → 本地）**：ChatSpaceManager 的 space-missing 分支调用
  `restoreFromMirror`——镜像有效 + spaceId 与绑定一致才恢复；恢复走
  `MemoryBackupRepository.restoreSpace`（按空间事务写六表，**不碰其他空间**，
  与全库清空的 restoreSnapshot 语义不同）。恢复成功发布 active（带 restored
  标记，面板展示「已从文件镜像恢复」）。
- **守卫**：临时/未保存对话不写；绑定无法识别不写；文件里已有无法识别的镜像
  不覆盖（降级安全）；防抖期间切走对话放弃本轮（防抖武装时捕获对话身份，
  触发时比对，且宿主重取 context——ST 的 saveMetadataDebounced 守卫只查
  group/character，不查 chatId，必须自查）。
- **开关**：设置「随对话文件同步记忆镜像」默认开（跟随插件总开关）+
  「镜像包含修订历史」默认开；状态展示镜像体积与上次写回时间。
- **体积**：v1 不设上限（用户决策）；缓解 = 状态展示体积 + 修订历史可关；
  后续如需限制做成设置字段。
