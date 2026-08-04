# 11 — Agent 引擎与 QueryAgent 技术设计

**Status:** 待评审（2026-08，与 11.5/12 重新拆分后整理）

> **阅读说明**：文档中标注「参考」的均为 pi 相关实现细节建议（API 名称、签名、版本号、事件名等），以实际安装版本的导出与签名为准，实现时不要死磕示例；领域与边界决策（全 key 交互、启用限制、结果形状、revision 语义、ticket 边界）为硬性约定。

---

## 1. 目标与范围

### 目标

- 在 core 引入 `@earendil-works/pi-agent-core` 通用 Agent 引擎并跑通（**仅 core，不碰 apps/api 与 apps/web**）；
- 实现只读 `query_records` 工具（本 Ticket **唯一**工具）；
- 实现 **QueryAgent**：对记忆空间内容提问的问答 Agent；
- 定义 LLM 端口 = `{ streamFn, Model, getApiKey }`（pi 类型）；具体 provider/配置构造不在本票实现。

### 本 Ticket 不做（边界）

| 内容 | 去向 |
|---|---|
| SSE 流式聊天端点、LLM 配置接入（env 读取、provider 构造、配置合并） | 11.5（api） |
| Web 聊天界面、LLM 配置表单、Token 浏览器保存约束 | 11.5（web） |
| submit_proposal 工具、提案 DSL、消息范围处理、提案端点与预览 | 12 |
| 安全阀（最大工具轮次、pageSize 硬上限） | 后续 |
| 引用字段 display 解析、`CustomAgentMessages` 声明合并 | 后续 |
| max_tokens 上限 | 不设上限，一般 LLM 参数可透传；「不处理 max_token」仅指不做按 token 切分处理块 |

---

## 2. 架构与边界

- **ADR-0008 / ADR-0018**：Agent 位于领域层之外。
- `core/src/memory`：纯领域 + 应用用例 + 端口，**零 pi 依赖，不改动**；Agent 只经现有只读端口（表/字段列表、`MemoryRecordQueryUseCases.query`）与它交互。
- `core/src/agent`（新模块）：pi 类型一等公民（`Agent` / `AgentTool` / `AgentMessage` / `Model` / `StreamFn`），**不发明包壳类型**。
- **LLM 端口 = `{ streamFn, Model, getApiKey }`**：类型在 agent 模块定义；apps/api 在 11.5 提供实现。
- **`MemorySpaceTableDigest`**：某一记忆空间**启用表/字段**的 schema 摘要（表 key、字段 key/名称/类型/必填/选项/引用目标），每次 run 构建一次；提示词组合与 query_records 工具校验共用同一份（模型可见范围 = 工具可用范围）。
- pi 事件流 → 聊天事件 → SSE：翻译点在 11.5 的 api 端点层，本票不涉及。

```
core/src/agent
 ├─ digest.ts              构造 MemorySpaceTableDigest（启用表/字段，每次 run 一次）
 ├─ prompt-composer.ts     QueryAgent 系统提示词
 ├─ query-records-tool.ts  AgentTool（schema + executor）
 └─ query-agent.ts         编排：new Agent → prompt(消息) → 提取回答

core/src/memory            只读端口（不变）
（apps/api、apps/web 接线见 11.5，本票不实现）
```

---

## 3. 依赖

| 包 | 版本（参考） | 用途 |
|---|---|---|
| `@earendil-works/pi-agent-core` | ^0.82.1（以安装为准） | Agent / AgentTool / 事件 |
| `@earendil-works/pi-ai` | ^0.82.1（以安装为准） | Models / Model / streamSimple / createProvider |
| `typebox` | ^1.1（以安装为准） | AgentTool 参数 schema |

引擎要求 Node >= 22.19（参考）；仓库 Node 24.18，满足。

---

## 4. LLM 端口（本票）与配置接入（11.5，参考）

**本票**：agent 模块只定义与消费端口类型 `{ streamFn, Model, getApiKey }`，不实现任何厂商接入。

**11.5 api 实现时参考（不写死）**：

- env 命名（参考）：`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`。
- 合并规则：逐字段 `web ?? env`（网页配置覆盖，空值回退服务端环境变量）。
- API Key：仅本次请求内存；不写 SQLite / localStorage / 日志。
- provider 构造（参考）：`createModels()` + `createProvider({ id, baseUrl, auth, models, api: openAICompletionsApi() })`，模型对象带 `baseUrl`；`streamFn = models.streamSimple.bind(models)`；`Agent.getApiKey` 钩子按 provider 返回 key（显式 key 优先于 provider/env 解析）。
- max_tokens 不设上限；一般 LLM 参数经流式调用选项透传。

---

## 5. Agent 运行机制

- **每请求一个 Agent 实例**（多轮历史由客户端回传，见 11.5）。
- 构造（参考）：
  ```ts
  new Agent({
    initialState: { systemPrompt, model, tools: [queryRecordsTool] },
    streamFn, getApiKey,
    convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  })
  ```
- **循环语义（普通 Agent）**：模型返回无 tool_calls（自然停止）即结束；本票不引入 submit_proposal、不设 `terminate`。
- **超时 5 分钟（参考）**：AbortController + 定时器 → 注入流式调用（signal）/ `agent.abort()`；按 streamFn 契约，取消/失败以 `stopReason: "error" | "aborted"` + `errorMessage` 编码（参考），不抛异常。
- **工具执行模式**：默认 `parallel`（参考）；query_records 只读，可并发多次查询。
- 安全阀（最大工具轮次、pageSize 硬上限）后续再做；查询服务层已有 pageSize cap 100。

---

## 6. query_records 工具（硬性约定）

### 6.1 Schema（TypeBox）

```jsonc
{
  "table": "characters",                    // 表 key，必填
  "fields": ["name", "current_status"],     // 可选，投影字段 key
  "conditions": [                           // 可选，AND 语义
    { "field": "current_status", "op": "contains", "value": "受伤" }
  ],
  "paging": { "page": 1, "pageSize": 20 },  // 可选，默认 1 / 20（服务层 cap 100）
  "orderBy": { "field": "$updated_at", "direction": "desc" }  // 可选
}
```

- `op`：8 个操作符的 TypeBox enum（`equals/not_equals/contains/not_contains/greater_than/greater_than_or_equal/less_than/less_than_or_equal`）——形状错误由 pi 在 execute 前自动拦截（参考）。
- `value`：`string | number | boolean | null` 联合。
- 系统字段：`$record_id`（equals/not_equals）、`$display_text`（文本操作符）、`$created_at` / `$updated_at`（有序操作符）。

### 6.2 执行流

```
params(keys) → `MemorySpaceTableDigest` 校验（表/字段存在且启用）→ key→id 映射
  → MemoryRecordQueryUseCases.query(spaceId, { tableId, fieldIds, conditions, paging, order })
  → 服务层类型感知校验（op×类型、选项、排序可排序性）
  → 结果 id→key 反映射 → 模型可读 JSON
```

### 6.3 结果形状

```jsonc
{
  "table": "characters", "page": 1, "pageSize": 20, "total": 3, "totalPages": 1,
  "records": [
    { "id": "01J...", "revisionId": "01J...", "display": "云烬",
      "values": { "name": "云烬", "aliases": ["云烬"], "current_status": "重伤", "location": "01J..." } }
  ]
}
```

- `values` 用**字段 key** 键控；不指定 `fields` 时返回全部启用字段。
- 剥离噪音：`fieldEvidence` / `source` / `tableId` / `memorySpaceId` 不进结果。
- **引用字段 v1 裸 id**（display 解析后续，需新增按 id 批量只读端口）。
- `id` + `revisionId` 保留：`revisionId` 是记录乐观并发版本号，供 12 提案 update/delete 的 `expectedRevisionId` 使用（提交时 `WHERE revision_id = expected` 做乐观锁，不匹配整批失败）。
- 空结果 `{ records: [], total: 0, ... }`，模型据此判断「该新建」。

### 6.4 错误处理

- 未知表/字段 key：throw，错误信息带**可用 key 列表**（pi 转 `isError: true` 工具结果回喂，模型自愈）（参考）。
- op×类型不匹配等：服务层 DomainError 转可读信息回喂。
- 描述中说明：条件为 AND（OR 请分多次查询）、contains 对文本是大小写不敏感子串 / 对列表字段是成员匹配、多值字段不可排序。

### 6.5 约束

- **只接受启用表/字段**（与 `MemorySpaceTableDigest` 一致）。
- **只读**：只经应用层查询端口，绝不绕过 Application 直连数据库。
- 本票不新增其他工具。

---

## 7. QueryAgent

- 提示词 = **基础问答指令** + **启用表/字段摘要**（`MemorySpaceTableDigest`：key、名称、类型、必填、选项、引用目标）。
- **`MemorySpaceTableDigest` 每次 run 构建一次**，prompt 组合与工具校验共用（模型可见范围 = 工具可用范围）。
- 只用 `query_records`，无写入工具；回答基于当前记录，不基于来源消息（来源消息与提案提示词归 12）。
- 输出：正常问答消息；思考/工具调用展示由 11.5 前端消费。

---

## 8. 端点与 Web 界面（归属 11.5）

SSE 流式端点、SSE 事件映射、多轮上下文方案、LLM 配置表单与 Token 浏览器保存约束均为 11.5 内容（见 `11.5-query-agent-chat.md`），本票不实现。

---

## 9. 测试策略

- **core/src/agent 单测**：脚本化假 `streamFn`（预排事件序列）跑整循环——工具调用 → 查询结果 → 回答；schema 形状校验；`MemorySpaceTableDigest` 启用/存在校验；工具错误回喂。**Agent 跑通以 core 级测试为准**，不依赖真实模型与 HTTP。
- api / web 测试归 11.5。
- 文件规模约束：单个代码文件不超过 300 行（对齐 15 的验收要求）。

---

## 10. 待定 / 开放点

1. 安全阀数值（最大工具轮次、pageSize 硬上限）后续。
2. 引用字段 display 解析后续（需新增按 id 批量只读端口）。
3. 是否通过工具描述提供「先列出可用表」的引导（倾向：写进描述即可，不新增工具）。
4. SSE 事件形状、多轮上下文、provider 细节：归 11.5 待定。
