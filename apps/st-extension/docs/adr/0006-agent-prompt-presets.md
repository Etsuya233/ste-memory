# Agent 提示词预设：模板模式 + 自研占位符展开，不接 ST MacroEngine

表格填写 Agent 的系统提示词可被用户预设覆盖：预设 = 命名档案，内含**片段**（命名 + 内容 + 开关 + 排序），启用片段按序拼接后经**占位符展开**成为最终 system prompt。全局一个**活动预设**；内置只读的**系统默认预设**（等价于未配置时的行为）作回退锚点。

**模板模式（不自动追加 digest）**：预设文本不会自动附加表/字段摘要（digest）——占位符 `{{tablesDigest}}` / `{{systemDefaultPrompt}}` 显式引用。选择「用户完全控制」而非「安全兜底」：破限与自定义场景需要干净文本，自动追加会让用户失去对最终提示词的确定感；代价是漏写占位符会降低 Agent 工具可用性，由编辑器在保存时提示一次（不拦）。core 零改动：`ProposalAgent` 既有 `composeSystemPrompt` 注入点，插件在填表任务装配时注入自定义组合器。

**占位符自研展开，不接 ST MacroEngine**：ST 的宏引擎（`MacroEngine`）不暴露任意文本展开的公共 API，静态 import 会被 esbuild 打进 bundle——与插件「只经 `getContext()` 适配器、永不静态 import ST 代码」的隔离策略冲突（ticket 12 确立）。故自研白名单替换器：`{{user}}`（name1）、`{{char}}`（单角色 name2 / 群聊=群名，与 ST 内建宏的「群聊=当前角色名」语义不同，刻意为之）、`{{tablesDigest}}`（composer 内用 run 时 digest 现算，无需预计算快照）、`{{systemDefaultPrompt}}`（默认提示词全文）。未知占位符原样保留。`{{tablesDigest}}` / `{{systemDefaultPrompt}}` 同时注册为 ST 全局宏（与记忆宏同模式），用户可在角色卡/提示词中使用；不注册 `{{user}}`/`{{char}}`（与 ST 内建宏重名会覆盖+警告）。

**不选方案**：接 `MacroEngine` 展开全部 ST 宏生态（破隔离策略、bundle 膨胀、版本耦合）；digest 自动追加（用户失去完全控制）；占位符注册为 ST 宏后依赖 ST 生成期展开（Agent 提示词不经 ST 组装，无人展开）；`{{group}}` 占位符（v1 最小集，群聊 char=群名已覆盖）；任务行记录预设快照（Dexie schema 变更，任务列表展示全局当前预设名即可）。
