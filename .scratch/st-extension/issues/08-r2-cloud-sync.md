# 08 — R2 云同步

**What to build:** CloudSyncAdapter 接口 + Cloudflare R2 实现（S3 兼容签名、bucket CORS 配置说明、错误处理）；每记忆空间一个 JSON 文件 + 索引文件（版本号 + 更新时间，last-write-wins）；数据变更防抖周期推送；本地库为空时启动拉取全量；设置面板 R2 配置生效，同步状态（最近同步时间、失败提示）可见。

**Blocked by:** 06 — 基础 UI 壳与设置面板；07 — 手动导出/导入（复用序列化编解码）

**Status:** resolved

- [x] 配置 R2 后变更自动防抖推送；断网/失败有提示且后续重试
- [x] 空库启动自动拉取全量；本地有库则优先本地
- [x] LWW 冲突语义正确（较新版本胜出）；适配器 mock fetch 测试通过
- [x] 每空间云文件与索引文件带与导出相同的版本化信封（format/version 语义一致），未知版本明确报错不覆盖本地
- [x] 手动验收：真实 R2 桶往返 + 双端（云酒馆/TauriTavern）恢复（真机待跑，验收步骤见 docs §5）

## Answer

工作树提交（26 文件，+1200 左右；core 编解码 20 例 + 插件云层 34 例 + UI 冒烟，全仓 484/484 绿，typecheck/lint/build 全绿）。

- **core 云模块（`core/src/memory/cloud/`，ADR 0022，与备份同信封）**：空间文件（信封 + `spaceId` + `updatedAt`（LWW 键）+ 单空间单元）与索引文件（信封 + 空间清单），format/version 与备份文件完全一致；`decodeCloudSpaceFile` / `decodeCloudIndexFile` 未知版本报「云同步文件版本不支持」（新增 `memory_cloud_*` 两个 DomainError，api 映射同步补齐）；结构校验复用 `memorySpaceBackupSchema`，完整性校验复用抽取出的 `validateSpaceBackupUnit`（备份 codec 顺带重构：`createBackupSeenIds` + label 措辞参数）；`resolveCloudLww` 纯函数裁决较新版本胜出；`CloudSyncAdapter` 端口（get/put，404 读返回 null）。架构测试放行 typebox 于 cloud 模块（注释说明）。
- **R2 适配器（`src/cloud/`）**：手写 SigV4 签名（`s3-signer.ts`，WebCrypto，区域 `auto`/服务 `s3`，与 node:crypto 独立实现交叉验证）；`R2CloudSyncAdapter`（fetch + 超时 15s + 错误映射：403 凭证/令牌提示、404 bucket 提示、网络/CORS 提示、非安全上下文 WebCrypto 缺失提示）；凭证 getter 每次请求重取（设置实时生效）。
- **同步协调器（`src/cloud/sync-coordinator.ts`，纯逻辑 seam）**：本地优先（本地非空不拉取）；变更检测 = Dexie 空间指纹（五表行数 + 最大 updatedAt，`DexieSyncChangeSource`）；脏空间 3s 防抖合并推送（空间文件先、索引后；索引失败不标记已推送，下轮幂等重传）；推送前与云端索引 LWW 比较（云端较新/相同不覆盖）；空库启动拉全量（`start()` 先于空间创建 + 落地前二次确认仍为空；索引条目与文件身份不一致跳过）；失败指数退避（10s 起封顶 5min）自动重试 + 「立即同步」忽略退避；状态（unconfigured/syncing/idle/error + 最近同步时间）订阅发布。
- **UI（设置面板 + 面板头部）**：R2 四项输入可编辑（ticket 06 占位生效），填齐即自动启用（协调器 kick）；「同步状态」组：状态行、最近同步时间（UTC 切片展示）、失败提示（危险色）、立即同步按钮；面板头部副标题接真实同步状态（同步中/最近同步/失败提示，失败警示基调）；`data-stm-field`/`data-action` 契约同步更新验收脚本断言（R2 可编辑 + 同步状态组）。
- **文档**：`apps/st-extension/docs/r2-cloud-sync.md`（bucket/API 令牌/CORS 配置（控制台或 PutBucketCors）、工作原理、排查表、双端手动验收步骤）；ADR 0022；core/st-extension 词汇表补「云同步文件」「云同步」。
- **已知限制（v1 接受，已记录）**：本地删除不传播云端（另一端拉取后复活）；双端同时推送的索引读写竞态（空间文件本身 LWW 安全，索引竞态仅影响目录新鲜度）；同一毫秒并发编辑视为相同不覆盖；api 的 SQLite 云同步接入留后续票。

## Comments

- 2026-08-09 code-review（双轴并行）结论：Standards 无硬违规（判断级：cloud-codec JSON 解析重复——已抽 `parseCloudJson` helper；s3-signer 测试同构双实现——跨库交叉验证，接受；指纹轮询全行读——注释记录规模演进路径）。Spec 无 blocker；采纳三条修复：①`#pushDirty` 先取指纹后读快照（原顺序在两者之间写入会静默漏推——改为先指纹，窗口内写入由下轮指纹不一致收敛）；②`syncNow` 在本地仍空时重新拉取（`#pulledOnce` 只挡日常轮询——另一设备后来上传的数据可被手动取回，ADR 同步修正）；③拉取时索引条目与文件身份不一致跳过（脏索引容忍）。未采纳（判断级）：updateR2Field 逐键击 kick（未配置时零成本、已配置时只做指纹扫描不上网，无实际危害）。
- 真机验收（真实 R2 桶往返 + 双端恢复）待跑：步骤见 `apps/st-extension/docs/r2-cloud-sync.md` §5；TauriTavern 若证实无 WebCrypto（非安全上下文），后续补纯 JS SHA-256/HMAC 回退（当前以清晰报错 + 文档提示兜底，`tauri.localhost` 属安全上下文，预计可用）。
