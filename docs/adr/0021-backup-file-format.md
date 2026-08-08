# 备份文件格式与编解码收进 core（ticket 07）

全库导出/导入的备份文件（`{ format, version, exportedAt, appVersion, data }`）序列化对象全部是 core 领域类型（记忆空间、记忆表格、字段、记录、修订历史、证据）。编解码模块放 `core/src/memory/export/`，api/web 与 st-extension 共享同一份格式定义与校验，避免两处实现导致格式漂移、备份互相不兼容；ticket 08（R2 云同步）复用同一套序列化。

选择共享而非复制的原因：备份文件是跨平台契约，双份实现必然漂移；编解码是纯函数（信封组装、结构校验、完整性校验、JSON 层），进 core 零成本，错误类型复用 `DomainError`。

不选方案：放 apps 共享包（`packages/memory-host-shared` 定位是宿主资产模板，备份格式是 core 领域概念的序列化形态，且 api 与插件之外再无宿主依赖差异）；插件与 api 各实现一份（双份漂移，导入校验行为不一致）。

范围边界：

- core 只含编解码纯函数与格式 schema（TypeBox）；**读取/写入全库快照走备份存储端口**（`MemoryBackupRepository`），由 st 的 Dexie 与 api 的 SQLite 各自实现，I/O 不进 core。
- 导入先校验 format/version：未知版本报「文件版本不支持」；结构校验带路径报错；另做完整性校验（各类 id 全局唯一、实体归属一致、引用目标存在），在触碰数据库之前拦截损坏文件。
- 恢复是整体替换且必须原子（st 的 Dexie 实现包在单事务里），绝不产生半导入状态。
- 信封 `appVersion` 是宿主应用版本（不是 core 版本），仅作诊断信息。
