# SillyTavern 1.18.0：宏参数 / 管道过滤器 / 世界书宏展开 / 预设与世界书写入 API

调研日期：2026-08-17。
核对版本：`tmp/SillyTavern_Source_Code`，git describe `1.18.0-1-g8172dcd0e`（紧贴 release 1.18.0）。
用途：ste-memory「记忆视图」（记忆宏表达式化 + 世界书注入，ADR 0025）前置事实。

## 结论摘要

| 事实 | 证据 | 对设计的影响 |
|---|---|---|
| 宏参数已可用：`{{name::arg1::arg2}}`，`MacroDefinitionOptions.unnamedArgs`，handler **同步**收 `context.unnamedArgs` | MacroRegistry.js:63-172、MacroParser.js:136-158 | 表达式能力走 ST 原生位置参数，无需自研宏引擎 |
| 参数内**任意字符合法**（中文/逗号/`=`），仅空白（SKIPPED）、`::`（分隔符）、`\|`（过滤器标志）、`}}`（宏结束）特殊 | MacroLexer.js:154（Unknown `/([^}]|\}(?!\}))/`）、MacroLexer.js:220-243（args 模式）、MacroParser.js:163-180（validArgumentTokens 含 Unknown/Equals/Quote/Colon） | 视图名可用中文；视图名校验 = 不含空白/`::`/`\|`/`}}` |
| 命名参数未实现（`namedArgs: null`，reserved） | MacroRegistry.js:156 | 不能用 ST 命名参数语法，`key=value` 需插件自己解析（本设计不采用，走命名视图） |
| 管道过滤器未实现（`>` 标志 `implemented: false`） | MacroFlags.js:48-53, 119-124；MacroLexer.js:66 | `{{x\|filter}}` 不可用，无注册 API |
| **WI 条目内容在激活时无条件展开宏**（含自定义注册宏） | world-info.js:4937-4939（`entry.content = substituteParams(entry.content)`）、4961（preventRecursion 只控递归扫描，与宏无关） | 用户把记忆宏放进 WI 条目内容即可，**插件零改动**；预算按展开后内容计 token（world-info.js:4940-4952） |
| 新宏引擎默认开启；关闭后自定义宏不展开 | power-user.js:302（`experimental_macro_engine: true`）、script.js:2922-2960（substituteParams 分支） | 既有风险，文档提示 |
| 旧 `macros.register(name, { handler })` 仍受支持（零参宏） | MacroRegistry.js:464+（buildMacroDefFromOptions） | 现有记忆宏注册不破坏；升级 = 加 unnamedArgs |
| WI 可编程读写：`loadWorldInfo` / `createWorldInfoEntry` / `saveWorldInfo(name, data, immediately)` | world-info.js:2036, 4057, 4097 | 能力存在；本设计不采用（用户可控优先） |
| 预设可编程读写：`getContext().getPresetManager(apiId)` → `getPresetSettings/savePreset`（写服务器文件） | preset-manager.js:466, 640；st-context.js | 能力存在；本设计不采用（侵入用户配置） |
| 扩展注入通道 `setExtensionPrompt(key, value, position, depth, scan, role, filter)` | script.js:8866；st-context.js:152；extensions/memory/index.js:965 | 运行时注入的自动方案备选，未采用 |
| `getContext().macros` 暴露完整新宏系统（engine/registry/envBuilder/lexer/parser/cstWalker/category/register/registerAlias） | st-context.js:244、macro-system.js:68-79 | 插件当前注册路径正确 |
| PromptManager 无扩展注册 API | PromptManager.js（内部类，无 registerPromptExtension） | 排除该路线 |
| 官方扩展模板无宏/WI/预设示例 | tmp/official-extension-template | 参考实现看 ST 内置扩展 memory/vectors |

## 1. 宏参数（Macro Args）

`getContext().macros` 直接暴露 `public/scripts/macros/macro-system.js` 的 `macros` 对象（`st-context.js:112` import、`:244` 暴露）。旧 API `getContext().registerMacro / unregisterMacro` 已 deprecated（`st-context.js:178-180`）。

`MacroDefinitionOptions`（`MacroRegistry.js:63-91`）：

```js
{ aliases?, category?, unnamedArgs? /* 数字=全部必填 | 定义数组（支持可选后缀） */,
  list? /* {min,max} 列表参数 */, strictArgs=true, description?, returns?,
  returnType=STRING, displayOverride?, exampleUsage?, delayArgResolution?,
  handler /* 必填，@typedef {(context: MacroExecutionContext) => string} */ }
```

`MacroUnnamedArgDef`（`MacroRegistry.js:105-120`）：`{ name, optional?, defaultValue?, type?(string|integer|number|boolean), sampleValue?, description? }`。

`MacroExecutionContext`（`MacroRegistry.js:134-172`）：`unnamedArgs`（位置参数）、`list`、`namedArgs`（**恒为 null**，预留）、`raw/rawArgs`、`isScoped/flags/env/range/globalOffset`、`resolve(text)`、`warn/normalize/trimContent`。

`MacroEngine.evaluate(input, env, { contextOffset })` 是**同步**函数直接返回字符串（`MacroEngine.js:117-158`）；`executeMacro` 同步调用 `def.handler(executionContext)`（`MacroRegistry.js:417-462`）。自定义宏 handler 必须同步返回字符串——与插件「预计算快照」方案一致。

参数语法（`MacroParser.js:136-158`）：

- 多参数规范写法：`{{name::arg1::arg2::...}}`（双冒号分隔）。
- 单参数：可选一个单冒号前缀 `{{name:arg}}`；`{{name:a:b}}` = 一个参数 `"a:b"`。
- 参数内允许 `=` 与 `"`；参数内可嵌套宏。
- 类型校验 `validateArgTypes`（`MacroRegistry.js:714-759`）；数量校验 `isArgsValid`（`MacroRegistry.js:699-712`）。

### 参数内字符集（本调研补充核实）

`MacroLexer.js:154` `Unknown: /([^}]|\}(?!\}))/`——除 `}}` 外任意单字符都被 lex 为 Unknown；args 模式（`MacroLexer.js:219-233`）对 Unknown 是 `using`（吸收进参数）。`MacroParser.js:163-180` 的 `validArgumentTokens = [嵌套宏, Identifier, Unknown, Args.Colon, Args.Equals, Args.Quote]`——**Unknown 被 parser 接受**。

因此结论：**中文、逗号、`=` 在参数内全部合法**；真正特殊的是：

- 空白（`WhiteSpace` 为 `Lexer.SKIPPED`，`MacroLexer.js:99`）——参数内不能有空白；
- `::`——分隔符（会切开参数）；
- `|`——args 模式中触发 filter 模式（`MacroLexer.js:220-224`）；
- `}}`——宏结束。

`{{memoryContext::未完成伏笔}}`、`{{memoryContext::status=埋设中,已触发}}` 均可解析。

## 2. 管道过滤器

**1.18.0 未实现**：`MacroFlags.js:48-53` 过滤器标志 `>` 注释「Filter feature not yet implemented」，`MacroFlagDefinitions` FILTER 条目 `implemented: false`（`MacroFlags.js:119-124`）；全仓无 FilterRegistry/registerFilter。唯一类似物是 MacroEngine 的 pre/post-processors（全局文本管道，非宏输出过滤器，无对外注册 API）。

## 3. 世界书条目里的宏

`world-info.js:4937-4939`（checkWorldInfo 激活循环内）：

```js
// Substitute macros inline, for both this checking and also future processing
entry.content = substituteParams(entry.content);
newContent += `${entry.content}\n`;
```

- 新宏引擎开启（默认）时 `substituteParams` 走 `MacroEngine.evaluate`（见上），**自定义注册的宏（含记忆宏）放 WI 条目内容里会在生成时被展开**，插件零改动。
- 无「禁用宏」开关：`preventRecursion`（`world-info.js:4017`、4961）只控制递归扫描，与宏无关；激活即无条件替换。
- WI 关键词也做宏替换（`world-info.js:4803`、4835）。
- 预算按**展开后**内容计 token（`world-info.js:4940-4952`）——大展开会挤占 WI 预算，用视图条数/字符上限控制。
- 宏展开发生在扫描激活时（生成管线内），handler 同步约束与预计算快照方案吻合。
- `getWorldInfoPrompt` 由 `getContext()` 暴露（`st-context.js:281`），插件已在 `worldbook-text.ts` 用它做 dry-run 扫描。

## 4. 提示词预设与扩展注入

- 预设构成：Chat Completion 预设（`openai_settings[presetName]`，`openai.js:404,4750`；`main_prompt/nsfw_prompt/jailbreak_prompt` 已迁移进 PromptManager 的 `prompts[]`，`PromptManager.js:36-57`）；Context 模板（`context_presets`/`story_string`，`power-user.js:249,348`）；System Prompt（`system_prompts`，`sysprompt.js:15`）。
- 扩展可编程读写：`getContext().getPresetManager(apiId)` → `getPresetSettings(name)`（preset-manager.js:640）/ `savePreset(name, settings)`（466，POST `/api/presets/save`）/ `getSelectedPresetName`（403）。**写服务器文件、侵入用户配置**。
- PromptManager **没有** `registerPromptExtension` 之类的扩展注册 API。
- 扩展注入标准通道是 `setExtensionPrompt(key, value, position, depth, scan, role, filter)`（script.js:8866，注释 "For use in UI extensions"），内置 memory 扩展即用此注入（extensions/memory/index.js:965）。本设计不采用（用户可控优先），留作自动注入方案的备选。

## 5. 世界书写入 API（能力存在，未采用）

- `loadWorldInfo(name)`（world-info.js:2036）：GET `/api/worldinfo/get`，返回含 `entries`（按 uid 为 key）的 WI 对象。
- `createWorldInfoEntry(_name, data)`（world-info.js:4057）：分配空闲 uid，按 `newWorldInfoEntryTemplate` 建条目并塞进 `data.entries[uid]`。模板字段（world-info.js:3995-4055）：`key/keysecondary/content/constant/selective/order/position/disable/ignoreBudget/preventRecursion/probability/depth/role`。
- `saveWorldInfo(name, data, immediately=false)`（world-info.js:4097）：写缓存 + 防抖保存；`immediately=true` 同步 POST `/api/worldinfo/edit` 并 emit `WORLDINFO_UPDATED`。JSDoc 警告：保存后不要改动传入的 data 对象。
- 无 `/wi-create` 之类专有 slash command。
