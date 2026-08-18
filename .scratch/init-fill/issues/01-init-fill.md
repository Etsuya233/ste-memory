# 01 — 初始化填表（任务服务路径 + Tasks tab 入口）

**What to build:** 新对话开始时，用户无需先发消息即可初始化记忆表格：在 Tasks tab 的「初始化填表」输入区粘贴设定文本并点击按钮，插件把文本框内容作为填表任务的 msg 输入（`{{msg}}` 占位符语义），连同活动 Agent 提示词预设一起喂给表格填写 Agent，由 Agent 按表格填写意图生成初始记录并自动落库。初始化是填表任务管线的一种输入形态（任务行以 kind 区分，无楼层、无台账、单块执行），不是新管线。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `FillTask` 增加 `kind: "floor" | "init"` 与 `initText` 字段（init 必填、floor 为 null），Dexie schema 升级迁移；旧任务行读取时缺省视为 floor，迁移后旧数据行为不变。
- [ ] `FillTaskService` 新增初始化提交路径：不做楼层范围校验；活动任务守卫（单空间单活动，`createIfIdle`）与 LLM 配置预检与楼层任务完全复用；initText 允许为空（trim 后空不拦截）；任务行持久化 initText 与 chatId 快照。
- [ ] 初始化任务退化为单块执行：合成单条来源消息（内容 = 清洗后的 initText）；清洗规则与楼层任务同路径（块处理时实时读取当前对话所选列表）；`{{msg}}` 展开输入 = 合成消息文本，未引用 `{{msg}}` 时自动追加块提示词（保持现有旧行为）；`{{worldbook}}` 扫描输入 = initText。
- [ ] 证据为单条 snapshot（`source_type: "init"`、`source_id: 任务 runId`、内容 = initText 原文），重复初始化每次生成新证据；初始化任务不读写楼层台账（不产生任何台账行）。
- [ ] 任务视图对 init 任务 `totalCount = 1`，进度轮询不查台账；运行记录照常写入填表日志（块范围为合成值）。
- [ ] `retry` 对 init 任务复用持久化 initText 重新提交（活动守卫冲突语义不变）；取消、失败收口、对话切换安全点与楼层任务一致。
- [ ] Tasks tab 新增「初始化填表」输入区（多行文本框 + 按钮）：无空间状态（未绑定/未保存）时禁用并提示；提交错误内联展示；纯逻辑进 task-panel-model（可测）。
- [ ] 任务历史与活动任务区按 kind 显示类型标签（初始化 / 填表）。
- [ ] 测试：FillTaskService seam 覆盖 submitInit 端到端（记录落库、snapshot 证据内容、无台账行、清洗应用、`{{msg}}` 两分支、与楼层任务双向互斥、retry 复用文本、取消/失败/对话切换）；repository 迁移测试（旧行缺省 floor、init 行读写）；task-panel-model 测试（空文本允许、空间不可用禁用、标签映射）。只测外部行为，不测循环内部细节。

**Spec:** `.scratch/init-fill/spec.md`
