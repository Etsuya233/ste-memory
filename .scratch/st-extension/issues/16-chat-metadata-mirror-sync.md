# 16 — ChatMetadata 镜像同步

**What to build:** 把记忆数据（结构 + 记录 + 修订历史 + 证据）镜像进 `chat_metadata.steMemoryMirror`（独立键，自含信封），随聊天文件走——文件同步到哪，记忆就跟到哪。**单通道**：不做与 R2 云同步的跨服务协调，两条通道各自「本地优先」，天然组合（用户决策 2026-08-10）。镜像只作**恢复源**（本地空间缺失时恢复），绝不覆盖本地；写回仅当本地较新（文件自洽）。**v1 不设体积上限**（用户决策），以设置项 + 体积展示兜底。设置面板加开关与状态展示。

**Blocked by:** 无（复用 08 已交付零件，均已 resolved：`DexieSyncChangeSource` 指纹 / `resolveCloudLww` / backup repository / `memorySpaceBackupSchema` + `validateSpaceBackupUnit`）

**Status:** resolved

## 背景与已核实事实（ST 源码，tmp/SillyTavern_Source_Code）

- `chat_metadata` 是聊天文件 JSONL 首行，随文件走（重命名自动跟随，ticket 05 已证）。加载时同步可用：`chat_metadata = chatHeader?.chat_metadata ?? {}`（script.js 7598）。
- ST 没有「只存 metadata」的轻量路径：`saveMetadataDebounced()` → `saveMetadata()` → `saveChatConditional()` → `saveChat()` 全量重写文件（script.js 7347+）。发消息/收消息/滑动/删除/重生成等流程本身就会全量保存——镜像只是搭便车，额外成本 = 记录变更时多一次防抖保存 + 每次保存的文件体积与序列化。
- 无 `CHAT_SAVED` 事件（events.js 全量确认），**不需要钩子**：写镜像后调 `saveMetadataDebounced()` 即可——1s 防抖（debounce_timeout.relaxed）+ 保存前重取 context 校验 group/character 未变（extensions.js 89-117，切对话不误写）。
- 现有 `restoreSnapshot` 是**全库清空重写**（memory-backup-repository.ts 52 行起）——R2 空库拉取可用，镜像「单空间缺失」恢复**不可用**，必须新增按空间恢复的 port。
- evidence 是独立表实体（记录 `fieldEvidence` 引用 `evidence_id`，repository `create(record, evidence)` 同时写表）——镜像要完整可恢复，data 必须与备份单元**完全同构**（space/tables/fields/records/history/evidence 六要素），schema 与校验直接复用，无需裁剪。

## 设计决策（草拟，待评审）

1. **键与信封**：`chat_metadata.steMemoryMirror = { format: "ste-memory-chat-mirror", version: 1, spaceId, updatedAt, appVersion, data }`，`data` = **完整 `MemorySpaceBackup`**（与备份/R2 空间文件的 data 同构；`updatedAt` = 空间指纹的 LWW 键）。**独立键、不动 `steMemory` 绑定键**——绑定读取路径（三态 + unrecognized 防御）零改动；旧版本插件忽略新键，降级安全。镜像自身未知版本/结构损坏 → 忽略镜像 + log，不打断打开流程。
2. **镜像内容**：结构 + 记录 + history + evidence（完整单元）。「包含修订历史（history）」做成设置开关（默认开）；关闭时镜像不含 history（记录照常，恢复无修订历史）。evidence 始终包含（记录恢复必需，体量小）。
3. **恢复（读侧）**：ChatSpaceManager 的 space-missing 分支尝试镜像恢复——条件：绑定为 bound + 镜像存在 + **镜像 spaceId 与绑定一致** + 本地无该空间。恢复走新 port `restoreSpace(unit)`（事务内按 spaceId 清旧写新，写六表含 history/evidence，不碰其他空间）。恢复失败/条件不满足 → 维持 space-missing。恢复成功 → 发布 active（带 restored 标记，面板可区分「从文件镜像恢复」）。
4. **写回（写侧）**：新纯逻辑 seam `ChatMetadataMirrorSync`（宿主 = StChatAdapter 扩展端口 readMirror/writeMirror，写即 saveMetadataDebounced）：
   - 轮询当前对话绑定空间的指纹（复用 `DexieSyncChangeSource`）→ 变化后防抖（3s，可注入）→ 构建镜像 → **序列化字节比较**（指纹变化 ⇒ 镜像内容必变，此比较为防御性保险，防抖窗口外的冗余触发）→ 写回；
   - 打开对话时本地较新 → 回填镜像（文件自洽，R2 拉取恢复后也顺带让文件追上）；
   - LWW：本地 `updatedAt` ≥ 镜像 → 不降级（不回写也不覆盖）；镜像较新而本地空间存在（异常态）→ 跳过 + warn；
   - 临时/未保存对话（chatId 无值）→ 跳过；绑定 unrecognized → 忽略镜像。
5. **体积**：v1 **不设上限**（用户决策 2026-08-10，不做 256KB 降级机制）。缓解：设置界面展示镜像体积（透明，用户自行判断）；history 开关可关（体积主要来源）；后续如需限制 → 做成设置字段「镜像体积上限（KB，0 = 不限制）」，本期不做。
6. **设置与状态**：开关「随对话文件同步记忆镜像」默认开启（跟随插件总开关）；开关「镜像包含修订历史」默认开启；状态展示：镜像体积、上次写回时间。UI 沿用 ticket 06 的 `data-stm-field`/`data-action` 契约。
7. **不做**（记录）：与 R2 的协调/合并（用户决策：单通道）；镜像增量推送（每次全量写镜像，v1 接受）；跨文件镜像同步（只推当前打开的对话，ST 内存限制）。

## Checklist

- [ ] core：镜像信封 + 编解码纯函数（`core/src/memory/chat-mirror/`，仿 cloud-codec：parse 前 `format/version` 校验、未知版本明确忽略路径；data 结构校验复用 `memorySpaceBackupSchema`，完整性校验复用 `validateSpaceBackupUnit`——data 与备份单元同构，直接复用零裁剪）
- [ ] core：`MemoryBackupRepository` 新 port `restoreSpace(unit)`（按空间事务恢复六表；Dexie 实现 + 测试证明**不误伤其他空间**、失败原子回滚）
- [ ] 宿主：StChatAdapter 扩展 `readMirror/writeMirror` 端口（写 = chatMetadata 赋值 + saveMetadataDebounced；read = 返回原始值，三态解码在 seam（镜像解码需全量 schema 校验，不放宿主薄层））
- [ ] 纯逻辑 seam `ChatMetadataMirrorSync`：指纹轮询 + 防抖合并 + 指纹跟踪跳过无变化（**无需序列化字节比较**：信封含 updatedAt 即指纹键，指纹变化 ⇒ 字节必变，已在实现注释记录）+ LWW 回写判定 + 打开时回填 + 恢复受镜像开关门控（fake timers 测试）
- [ ] ChatSpaceManager：space-missing 分支镜像恢复（条件全测：spaceId 不一致忽略、镜像无效忽略、恢复失败维持 space-missing、恢复成功发布 active/restored）
- [ ] history 开关：关闭时镜像不含 history（编解码/恢复/写回全链路测试）
- [ ] 设置面板：镜像开关 + history 开关 + 状态展示（镜像体积/上次写回时间），验收脚本契约同步
- [ ] 测试：core 编解码往返/未知版本；seam 全测（上文各条件 + unsaved-chat 跳过 + 绑定 unrecognized 忽略镜像 + 切对话不误写（重取 context）+ 恢复含 history/evidence 完整还原）；宿主薄层；全仓绿 + typecheck/lint/build
- [ ] 手动验收步骤（真实 ST：双端/重命名跟随/删除文件后从镜像恢复/长对话体积观察）写入 `docs/`；spec 与 ADR 更新（「ChatMetadata 同步器」从未来候选转正 + 决策记录 + 词汇表补「镜像」）

## Comments

- 2026-08-10 分析结论（用户提问「能不能写 ChatMetadata 同步」）：可行，机制有先例（参考插件 ST-Memory-Context 即 chatMetadata 同步）。用户决策：①单通道，不做跨服务协调；②结构 + 记录都要同步。复用判定：CloudSyncCoordinator 本体不复用（网络/索引/全库拉取/推全部空间 vs 无网络/单文件/打开时恢复/只推当前对话——形态不同），零件复用（DexieSyncChangeSource / resolveCloudLww / 备份 schema / validateSpaceBackupUnit）。关键发现：restoreSnapshot 全库清空，镜像恢复必须新增按空间恢复 port。保存机制核实：无 CHAT_SAVED 事件但不需要钩子——saveMetadataDebounced 已具备（1s 防抖 + 切对话守卫）。
- 2026-08-10 用户评审反馈（已采纳）：①v1 不设体积上限（去掉 256KB 降级机制），体积风险以设置界面体积展示 + history 开关兜底，后续如需限制做成设置字段；②镜像包含 history（此前拟排除）——data 因此与备份单元完全同构，schema/校验直接复用；③history 包含与否做成设置项。另核实：evidence 为独立表实体（fieldEvidence 引用 evidence_id），完整恢复必须包含——一并纳入镜像，无需裁剪。

## Answer

工作树提交（31 文件，+1900 左右；core 编解码 10 例 + 仓库恢复 3 例 + seam 20 例 + manager 恢复 3 例 + runtime 集成 3 例 + 宿主 2 例 + 设置 2 例 + UI 冒烟 5 例；全仓 529/529 绿，typecheck/lint/build 全绿）。code-review（双轴并行）无 blocker，采纳修复：陈旧注释清理（字节比较已删）、`restoreFromMirror` 补镜像开关门控（关闭开关 = 写与恢复都不执行，文档已一致）。

- **core 镜像模块（`core/src/memory/chat-mirror/`，ADR 0023，data 与备份单元完全同构）**：信封 `{ format: "ste-memory-chat-mirror", version: 1, spaceId, updatedAt, appVersion, data }`；`createChatMirrorFile`（includeHistory=false 裁 history）与 `decodeChatMirrorFile`（**忽略语义**：未知版本/损坏/spaceId 不一致/完整性违规一律返回 null，不抛错不覆盖——与云同步文件的抛错中止相反）；结构校验复用 `memorySpaceBackupSchema`、完整性校验复用 `validateSpaceBackupUnit`，零裁剪。
- **`MemoryBackupRepository.restoreSpace`（core port + Dexie 实现）**：按空间事务恢复六表（先删该空间全部行再写单元；memoryFields 无索引走 filter，注释记录口径），**不碰其他空间**、失败整体回滚；restoreSnapshot 重构出共享 `#writeUnit`。
- **镜像同步 seam（`src/chat-mirror/chat-metadata-mirror-sync.ts`，纯逻辑）**：写回 = 2s 指纹轮询（复用 DexieSyncChangeSource）→ 3s 防抖合并（武装时捕获对话身份，触发时比对——ST 的 saveMetadataDebounced 守卫不查 chatId 必须自查）→ LWW（本地较新才写，相等/较新跳过，较新 warn）→ 宿主写 chatMetadata + saveMetadataDebounced；文件身份跟踪（chatIdentityKey，复制的对话文件共享空间不互相漏写）；空指纹（绑定在、空间缺失）跳过；文件里无法识别镜像不覆盖 + warn；恢复 = `restoreFromMirror`（镜像开关门控 + 镜像有效 + spaceId 与绑定一致 → restoreSpace → true）；状态（disabled / idle + 上次写回时间 + 体积）订阅发布。
- **ChatSpaceManager**：active 状态加 `restored` 标记；space-missing 分支经可选 `mirrorRestore` 端口尝试恢复（成功 → active/restored，失败/条件不满足 → 维持 space-missing；同步期间切走不发布）；`chatIdentityKey` 从私有函数提升为共享导出。
- **宿主（StChatAdapter）**：独立键 `steMemoryMirror`（不动绑定键，降级安全），`mirrorStore` 读写端口（写即 saveMetadataDebounced；read 返回原始值，三态解码在 seam——全量 schema 校验不放宿主薄层）。
- **设置与 UI**：`settings.mirror = { enabled: true, includeHistory: true }`（mergeSettings 向前兼容）；设置面板「对话文件镜像」组（两开关 data-action=toggle-mirror / toggle-mirror-history + 状态行 data-stm-field=mirror-status）；面板头部「已从文件镜像恢复 · …」标记；`verify-ui-shell.mjs` 契约同步。
- **文档**：ADR 0023、spec 决策 5/12/13 + Out of Scope + Further Notes 更新（「ChatMetadata 同步器」从未来候选转正）、`apps/st-extension/CONTEXT.md` 词汇表补「对话文件镜像」、`docs/chat-metadata-mirror.md`（机制 + 设置 + 已知限制 + 6 步手动验收）。
- **实现中偏离清单的两处（已在 Checklist 注明）**：①序列化字节比较省略——信封含 updatedAt（即指纹键），指纹变化 ⇒ 字节必变，字节比较是死代码，以指纹跟踪取代（PushedMirror 注释记录理由）；②宿主 read 三态改为原始值 + seam 解码（校验归 core codec）。
- **已知限制（v1 接受，已记录）**：写回失败无失败信号（ST 无 CHAT_SAVED 事件，状态只展示上次写回时间）；本地删除不传播（打开时镜像复活，与 R2 同源）；文件镜像较新而本地空间存在只 warn 不动作；v1 不设体积上限（状态展示体积 + 修订历史开关兜底）。
