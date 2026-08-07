# 存储分层：Dexie 本地事实源 + chatMetadata 指针 + R2 云同步

记忆数据分三层存放：**Dexie（IndexedDB）**是本地事实源（表格定义、记录、修订历史、任务状态，各 core 端口 repository 的浏览器实现）；**chatMetadata** 只存小指针（记忆空间绑定 + 同步游标，随聊天 jsonl 走，对话重命名自动跟随）；**云同步适配器**（`CloudSyncAdapter` 接口）把数据序列化为每空间一个 JSON 文件 + 索引文件，周期推送到 Cloudflare R2（S3 兼容，access key + secret + 原生 CORS），启动时本地库为空（新设备 / iOS 存储被清）则从云端拉全量；冲突 last-write-wins（版本号 + 更新时间）。

选择该分层的背景：用户双端使用云酒馆（浏览器）与 TauriTavern（iOS，WKWebView 本地存储可能被系统驱逐）——云同步是持久层而非加分项。chatMetadata 不适合承载数据库：`saveChat` 每次把整个对话数组全量 POST 重写聊天文件，大 blob 会让每次保存都背全量负担（参考插件 ST-Memory-Context 用 chatMetadata 同步，正是因为其数据量小）。云服务选型：坚果云等 WebDAV 无 CORS 头、浏览器 fetch 不可直连；Google Drive 只有 OAuth（无 API Key 模式）；S3 兼容服务原生支持 CORS，是唯一「API Key 风格」的浏览器友好选项，R2 免费额度大且无流量费。

接受的代价：access key/secret 明文存于浏览器插件设置，任何可读浏览器的扩展都能看到——本地单用户实验可接受，与项目无认证现状一致（ADR 0017 精神）。

不选方案：全量数据进 chatMetadata（聊天文件膨胀 + 每次保存全量传输）；localStorage（5MB 上限 + iOS 驱逐风险）；WebDAV 首发（CORS 阻断，除非自建并开 CORS）；Google Drive 首发（OAuth 流程重，留作后续适配器）；Server Plugin 承载存储（未来路线，且覆盖不了 TauriTavern）。
