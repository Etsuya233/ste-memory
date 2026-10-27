---
status: accepted
date: 2026-10-27
---

# 共享语义评分源的可选重排

扩展 `semantic_scores`，增加第四个可选 JSON 参数，支持 `rerank`、`candidateLimit`、`textFields`、`scopeRecordIds`。
默认跟随全局开关；旧设置默认关闭。先限定业务 scope，再进行向量评分和记录去重、选候选、重排。

保留 scope 内全部有效评分行和原有 `score`、`group_key` 语义，增加 `rerank_score`、`rerank_rank` 和当前排序 `rank`。
未重排的候选外记录保留但重排相关列为 NULL。普通调用关闭重排时 `rank` 为向量名次。
最终 SQL 显式使用 `WHERE rank IS NOT NULL ORDER BY rank`；旧余弦阈值不改写。

启用重排的宏 Query 业务条件形成 scope，评分条件在之后执行，最终 limit 保持原有含义；
关闭重排时业务条件保留在最终 SQL，不增加候选范围预查询与上限。宏 SQL、查询 Agent 和控制台共用评分源。
候选文本默认使用所选组字段并集，显式 textFields 可覆盖；字段及引用读取固定快照。重排请求批内复用，
沿用生成门禁、总 deadline 和取消，不使用静默回退。实际注入在最终 SQL/Query 成功后按现有格式和字符预算渲染。

本决策扩展 ADR 0026。与宏层后处理相比，它保留重排后的 SQL 过滤、关联和投影能力，代价是扩展虚拟表及动态 scope 协议。
首版限制为单表记录级重排，不提供无界全量重排或聚合结果文档重排。

使用说明和硬限制见 [共享语义 SQL](../../semantic-sql.md#可选-rerank)。
HTTP 协议依据 [Cohere Rerank API](https://docs.cohere.com/reference/rerank)，端点使用用户提供的完整地址。
