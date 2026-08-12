# 填表日志（通用日志 + 运行记录）

Status: ready-for-agent

## Problem Statement

填表任务运行过程完全不可见：用户只能看到任务状态、进度与最终提案结果，看不到模型每次调用收到的 Prompt、工具调用过程与模型输出。任务失败或填错时，无法复盘"模型当时看到了什么、做了什么决策、哪一步出错了"。插件侧 Agent run 目前未捕获任何事件（`hooks: {}`），事后无迹可查。

## Solution

一个**通用日志表**（一张 Dexie 表，type/key/level 过滤，纯本地）：填表任务运行时，每个消息块产生一条**运行记录**，快照该块 Agent 运行的完整过程——逐轮 LLM 请求消息（含系统提示词展开快照与对话全文）、工具调用（参数/结果/错误）、模型输出（含用量与停止原因）。UI 新增独立"日志"tab：按类型/空间/级别/key 过滤浏览，点击展开块内轮时间线；任务面板的历史任务行提供"查看日志"入口直达该任务的运行记录。日志为审计数据，不参与云同步、备份与对话文件镜像（ADR 0008）。

## User Stories

**日志记录**

1. 作为用户，我想在填表任务运行后看到每条块的运行记录，以便复盘 Agent 的填写过程
2. 作为用户，我想看到每个块中每轮 LLM 调用实际收到的完整请求消息（系统提示词 + 上下文消息），以便理解模型决策依据
3. 作为用户，我想看到工具调用的参数与返回结果（含错误标记），以便判断 Agent 是否做出了错误操作
4. 作为用户，我想看到每轮模型输出（文本回复、停止原因、token 用量），以便评估模型行为
5. 作为用户，我想看到系统提示词快照（预设片段展开 + 世界书展开后的最终文本），以便知道模型当时的指令环境
6. 作为用户，任务块失败时我能看到该块的运行记录（已完成轮 + 错误信息），以便定位失败原因
7. 作为用户，任务被中断时我能看到已完成块的运行记录（未完成块标记为中断），以便确认中断前做了什么
8. 作为用户，我想看到每条运行记录的状态（成功/失败/中断）、起止时间与耗时，以便快速了解块的结果

**通用日志与过滤**

9. 作为用户，我想按日志类型过滤（如只看填表运行记录），以便在日志类型增多后聚焦
10. 作为用户，我想按记忆空间过滤日志，以便只看当前空间的记录
11. 作为用户，我想按级别（level）过滤日志（如只看 error），以便快速发现异常
12. 作为用户，我想按 key 搜索日志，以便定位某个任务的运行记录
13. 作为用户，我想看到每条日志的级别标记（info/warn/error），以便在列表中一眼区分结果

**查看与导航**

14. 作为用户，我想在日志 tab 中按时间倒序浏览运行记录列表，以便查看最近的运行
15. 作为用户，我想点击一条运行记录展开详情（块内按轮展示时间线），以便细看每一轮
16. 作为用户，我想折叠/展开大段内容（请求消息、工具参数），以便快速浏览
17. 作为用户，我想从任务面板的历史任务行点击"查看日志"，跳到日志 tab 并定位到该任务的全部运行记录，以便刚跑完任务直接复盘
18. 作为用户，失败块在列表中应有明显标记，以便快速找到出错的块

**数据管理**

19. 作为用户，日志不会出现在云同步、备份文件与对话文件镜像中，以便对话原文与提示词不离开本地
20. 作为用户，日志超过上限时自动清理最旧条目，以便本地存储不无限增长
21. 作为用户，我删除记忆空间时该空间的日志一并删除，以便不残留孤儿数据
22. 作为用户，我可以手动清空日志，以便清理敏感内容

## Implementation Decisions

**通用日志表（Dexie v4，`memoryLogs`）**

- 行结构：`id`（自增主键，插入顺序即时间顺序，供修剪删最旧）、`type`（日志类型）、`key`（过滤键，**语义由各日志类型自行定义**）、`spaceId`（可空，按记忆空间过滤）、`level`（`"info" | "warn" | "error"`，由各类型写入时标注）、`data`（自由 JSON，类型各自定义结构）、`createdAt`
- 索引：`[type+createdAt]`、`[spaceId+createdAt]`。level 不建索引——全局 1000 条上限内内存过滤可接受，不为过滤扩索引
- 全局条数上限 1000：append 后超出时同一事务删除最旧（按 id 升序）；清理维度为全局而非每 key（重试多不撑爆单任务日志）
- 填表类型的 key = 任务 runId；块范围在 data 内（同一任务的多条运行记录共享 key）

**日志仓库与服务**

- `LogRepository`（Dexie 实现）：`append(type, key, spaceId, level, data)`（含超限修剪）、按 type / 按 key / 按 spaceId 查询（时间倒序）、`clearAll`、空间级联删除
- 仓库接口与查询保持通用，不出现填表专属字段；填表只是调用方之一

**运行记录捕获（FillTaskService 内）**

- FillTaskService 增加日志仓库依赖；块结束时（`#processBlock` 尾部）组装并写入一条运行记录，**成功、失败、中断都写**
- 捕获双源：包装 `streamFn`（每次调用观察完整请求快照 `context.systemPrompt + context.messages`，并收集结果消息含 usage/stopReason/errorMessage）；`RunHooks.onEvent` 收集 `turn_end`（消息 + 工具结果配对，含 isError）
- 中断块语义：任务取消落地后安全点停止的块，写入状态 `interrupted`（该轮 Agent 已完成但提案被丢弃，不落库）
- 运行记录 data 形状（设计会话定稿，决策密集部分内联）：

```ts
// 运行记录（type: "fill" 的 data 载荷）
interface FillRunRecord {
  taskRunId: string;                    // 与 key 列同值
  block: { from: number; to: number };
  status: "succeeded" | "failed" | "interrupted";
  errorMessage: string | null;
  systemPrompt: string;                 // 块级一份（预设+世界书展开快照），轮内不重复
  rounds: FillRunRound[];               // 一次块运行 = 1..N 轮 LLM 调用
  startedAt: string;
  endedAt: string;
  durationMs: number;
}
interface FillRunRound {
  request: { messages: AgentMessage[] };       // 该轮 LLM 收到的完整消息列表（含工具结果历史）
  output: { content: unknown; stopReason: string | undefined; usage: unknown; errorMessage: string | undefined };
  toolResults: { toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean }[];
}
```

- 级别标注：块成功 `info`、块失败 `error`、块中断 `warn`

**UI**

- panel-shell 新增顶层 tab `"logs"`（`PANEL_TABS` / `PANEL_TAB_LABELS` 各加一项）
- 新 `log-panel-model`（纯状态，与 task-panel-model 同模式）：过滤状态（type / 空间 / level / key 文本）、列表视图模型（时间倒序、级别徽标、摘要行）、详情展开状态（块内轮时间线）、导航定位状态
- LogTab 组件：过滤控件 + 列表 + 详情（请求消息可折叠、工具调用参数/结果、模型输出、用量、耗时）
- tasks-tab 历史任务行加"查看日志"入口：经面板模型 `setTab("logs")` + 定位过滤（key = 该任务 runId）
- 手动"清空日志"入口在日志 tab 内

**本地性与级联**

- 云同步指纹（`DexieSyncChangeSource`）只统计记忆表，日志表不加入——天然不同步；备份/镜像序列化路径不包含日志表
- `memory-space-repository` 的 delete 增加日志表级联清理（现有已级联 6 表，模式一致）

## Testing Decisions

- 好测试的标准：只断言外部行为——"跑完任务后日志表里有什么"，不测捕获内部实现细节（包装器如何迭代流等）
- 复用既有三层测试缝，不新增：
  - **仓库层**：`db/log-repository.test.ts`（新）——append/按 type/key/spaceId 查询/超限修剪/清空/级联，fake-indexeddb + `createTestDatabase`。先例：`db/fill-task-repository.test.ts`
  - **集成层**：扩展 `fill-tasks/fill-task-service.test.ts`——沿用脚本化 LLM harness（`scriptedStreamFn` 等），断言：成功任务每块一条运行记录且内容正确（系统提示词快照、轮数、工具调用参数/结果、输出、用量、耗时）；失败块写 error 级记录（已完成轮 + 错误信息）；中断任务写 interrupted 级记录；修剪在 append 时生效。先例：现有 49 个测试
  - **状态模型层**：`ui/log-panel-model.test.ts`（新）——过滤组合、列表排序、详情展开、导航定位。先例：`ui/task-panel-model.test.ts`
  - `memory-space-repository` 测试补充级联断言
- 渲染层不测（与现有 tasks-tab.tsx 无渲染测试的先例一致）

## Out of Scope

- 运行中任务的实时逐轮直播（日志在块结束时写入；实时事件流是 apps 侧形态，不引入）
- 查询 Agent 及其他日志类型（表与仓库已通用，本次只实现 fill 类型）
- 日志导出/备份/云同步
- 渲染层组件测试
- 日志类型的自定义 level 策略框架（各类型自行标注即可）

## Further Notes

- ADR 0008（`apps/st-extension/docs/adr/0008-fill-log-prompt-snapshot.md`）已记录"日志快照完整 Prompt"对"消息全文不落库"原则的受控例外
- 词汇表已更新：通用日志、填表日志、运行记录、工具调用；同步楼层条目标注例外
- level 为顶层列的决定来自用户补充（过滤与展示需要），索引策略按 1000 条上限的内存过滤设计
