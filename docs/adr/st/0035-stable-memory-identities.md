# 空间与记忆记录的稳定身份

日期：2026-11-01。状态：已实现。

## 决策

空间与当前记录增加必填 `stableId`，历史保存原记忆记录的 `stableId`。本地 `id` 继续承担 SQLite 仓库、字段引用、聊天绑定与请求定位职责。稳定身份只表示跨副本谱系，消费方以空间与记录的稳定身份组合保存关联。

新建实体在创建时分配一次稳定身份，可直接采用该次生成的本地 ID；更新、归档、删除前历史与清除记录保持空间或记录既有稳定身份。导入与分支克隆重建本地实体 ID、保留稳定身份及既有修订关联；副本的新记录获得独立身份。

应用预设整体重建从注入的 ID 工厂生成新的空间稳定身份，本地空间 ID 与聊天绑定保留；从预设按 Key 更新结构保留稳定身份。重建候选持有该次身份，文件保存重试继续保存同一候选。

记录稳定身份在单空间跨表唯一，历史版本必须与原记录对应；不同空间的副本可以共享稳定身份。快照完整性检查覆盖当前与已删除记录，SQLite 权威记录集合另以唯一索引约束当前记录。

## 迁移与协议

领域快照升级为 v3，文件外壳仍为 v3。旧外壳 v1/v2、领域快照 v1/v2 通过统一纯迁移入口升级：空间取原空间 ID，当前记录取原记录 ID，历史取 `recordId`。当前格式缺失或空字符串稳定身份拒绝；迁移不生成随机身份，不改变输入。

`STE_MEMORY_API.identity.version === 1` 宣告稳定身份能力；顶层和 `database` 均维持 v1。只读快照暴露 `stableId`，数据库描述暴露 `space.stableId`，各业务表公开 `$stable_id` 并允许公共只读查询。`schemaKey` 包含空间稳定身份，重建后既有映射失效。请求仍携带当前 `chatIdentity`、`spaceId` 和 `schemaKey`。

本决策补充 ADR 0031 的只读协议与 ADR 0032 的快照迁移规则，保持 ADR 0034 的宿主保存和操作归属边界。

## 维护入口

- `features/memory/domain/` 定义稳定身份；记录创建与历史归档由记录服务和 mutation batch 维护。
- `features/memory-snapshot/` 集中版本升级、完整性检查与副本转换。
- `features/table-presets/table-preset-apply-service.ts` 分配重建身份，`runtime.ts` 注入既有 ID 工厂。
- `infrastructure/sqlite/engine.ts` 保存实体并发布业务表列，`public-query.ts` 管描述、schemaKey 与只读授权。
