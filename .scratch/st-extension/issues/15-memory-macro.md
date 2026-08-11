# 15 — 记忆宏

**What to build:** 记忆宏：经 context.macros.register 注册，宏名由用户配置（默认建议 {{memoryContext}}）；宏 handler 同步返回预计算快照（ST 宏引擎同步约束），快照在数据变更（同步/填表/手动编辑）时重建；组装规则 = 按启用表分组（表名 + 记录显示文本，复用 core 显示策略）+ 可配置上限截断；设置面板提供宏名与范围/上限配置。

**输出格式契约**：按启用表分组，表名标题行 + 每条记录显示文本一行，空表省略，停用表不参与；默认上限 2000 字符（可配置），从尾部截断并附「……（已截断）」标记：

```
【人物】
张三：身份/定位…
李四：…

【地点】
…
```

**Blocked by:** 04 — Dexie 持久层（二）；06 — 基础 UI 壳与设置面板

**Status:** resolved

## Answer

`apps/st-extension/src/macros/` 新增三层（纯逻辑 + 服务 + 测试），全部验收项闭环：

- **纯逻辑（`macros/memory-context-snapshot.ts`）**：`assembleMemoryContextSnapshot`（按启用表分组：表名标题行 + 记录显示文本一行，空表省略、停用表不参与；组内按 updatedAt 倒序——尾部截断保留最新记忆；换行单行化保证「每条记录一行」契约）+ `truncateWithMarker`（尾部截断，总长 = 上限，附「……（已截断）」标记；上限小于标记长时输出仅标记）。`macros/macro-name.ts`：`resolveMacroRegistrationName`——设置值（默认 `{{memoryContext}}`，可整段粘贴）解析为 ST 注册名（裸标识符），校验 ST 标识符规则 `/^[a-zA-Z][\w-_]*$/`（源码 MacroLexer 同源核实）；非法/为空 → undefined（不注册 = 无注入）。
- **服务（`macros/memory-macro-service.ts`，纯逻辑 seam）**：注册生命周期（插件停用/名字非法 → 注销；名字变化 → 注销旧名注册新名；同名幂等）；快照预计算——轮询当前绑定空间变更指纹（DexieSyncChangeSource，与云同步/镜像同机制），指纹变化（同步/填表/手动编辑/导入都会改变行数或最大 updatedAt）→ 重建；上限变化也参与重建判定（指纹不反映设置）；无活动空间 → 快照置空下轮收敛；宏 handler 同步返回 `#snapshot`（ST 宏引擎同步约束）。
- **设置（`settings/plugin-settings.ts`）**：`PluginSettings` 补 `macroLimit`（默认 2000，合并时负数/非数回退默认）；设置面板「记忆宏」组启用（宏名 + 上限输入，改动即写设置 + `macro.kick()` 立即生效）。
- **ST 适配器（`st/st-chat-adapter.ts`）**：`StContext` 补 `macros` 字段（register/registry.unregisterMacro，release 1.18.0 macro-system.js 已核实签名：name 为裸标识符、同名覆盖警告、handler 同步）；`macroRegistration` 端口薄层（宿主缺失宏引擎时静默跳过）。
- **运行时接线（`runtime.ts`）**：`macro` 服务实例 + `SteMemoryRuntime.macro` + 面板 `PanelRuntime.macro.kick`；`macro.start()` 放在首次空间同步之后（活动空间就绪即展开最新记忆，不等第一轮轮询）。
- **测试（包内 462/462 绿，typecheck/lint/build 全绿）**：快照组装 9 例（格式契约/空表/停用表/排序/截断边界/单行化）；宏名解析 6 例；服务 12 例（fake 端口 + fake timers：注册生命周期、指纹变化重建/未变跳过、切空间收敛、上限 kick 重建、失败保旧值）；settings 合并补 3 例；runtime 接线 1 例（注册 → 建记录 kick → 展开最新记忆 → 改名重注册 → 停用注销）；面板冒烟更新（宏输入可编辑 + 上限字段）。
- **手动验收（2026-08-11 真机，`docs/playwright-st-extension/verify-memory-macro.mjs` 7/7 全绿）**：真实 ST 1.18 中——默认宏名注册（裸标识符断言）→ 空库展开空串 → 建记录后宏引擎真实展开（`macros.engine.evaluate`）含「【人物】\n张三」→ 第二条记录最新在前 → 上限 9 截断 + 标记（总长 = 上限）→ 设置面板改名 `{{myMemory}}` 旧名注销新名生效 → 自清理（删记录恢复设置）→ 无插件相关页面错误。`verify-ui-shell.mjs` 27/27 重跑全绿（宏输入断言改为可编辑 + 上限 2000）。

## Checklist

- [x] 宏展开输出当前记忆上下文（启用表分组 + 显示文本 + 上限截断）
- [x] 宏名自定义生效；不放置宏则无注入（名字非法/为空/插件停用 → 注销不注册）
- [x] 快照刷新时机正确（指纹轮询重建）；组装逻辑为纯函数并有测试（29 例）
- [x] 输出格式符合格式契约（分组/空表省略/尾部截断标记）；上限默认 2000 字符可配置
- [x] 手动验收：真实 ST 宏引擎展开最新记忆（verify-memory-macro.mjs 7/7）

## Comments

- **2026-08-11 用户实测修复（陈旧窗口）**：用户添加数据后立即生成，宏展开为空（token 0）。根因：宏快照靠 2s 指纹轮询重建，面板操作/打开对话后**立即**生成会命中陈旧窗口（复现：写操作后 300ms 快照仍旧值；打开对话后 2.5s 才恢复）。两处修复（均已真机验证）：①**面板数据操作后立即 kick**——`panel-shell.tsx` TablesTab 与 `record-view.tsx` 新增 `bumpData()`（setReloadKey + `macro.kick()`），替换全部数据操作收尾（表格/字段启停、建删改、显示策略、记录网格保存/删除、备份导入）；②**空间切换立即重建**——runtime 订阅 `manager.onStatusChange` → `macro.kick()`（打开对话后 158ms 快照就绪，实测远小于轮询间隔）。曾尝试 Dexie `db.on("changes")` 事件驱动（更根治）但 Dexie 4 核心不注册该事件（属 Syncable 插件），`storagemutated` 亦需 observable 中间件——退回 UI kick 方案（与 sync.kick/mirror.kick 同模式）。测试补充：runtime 切对话立即重建用例；服务 31 例 + 包内 464/464 全绿；verify-memory-macro 7/7 + verify-ui-shell 31 项回归全绿。
- 2026-08-11 code-review（双轴并行）结论：Standards 1 blocker + Spec 1 blocker，均已修复并回归验证：①**停用分支重置不完整**（memory-macro-service）：插件停用/宏名非法分支清快照但未重置空间/指纹/上限状态，重新启用且数据未变时命中「指纹相同早退」→ 快照永久为空；修复 = 分支内三字段一并重置，测试补断言（停用→启用、数据未变、快照恢复）②**重新启用插件不 kick 宏**（panel-shell togglePlugin）：停用期间宏已注销且停止轮询，启用只恢复了空间同步，宏不恢复注册；修复 = 启用分支补 `macro.kick()`。判断级未采纳：`defaultTimers` 第三份拷贝（与 sync-coordinator/mirror 同模式，提取共享属跨票重构）；`updateMacroLimit` 的 isFinite 守卫（UI 侧防写入非法值，读侧 merge 仍兜底）。验收脚本断言数口径：README 改 7 项；`[...truncated].length` 与 service `.length` 码点/UTF-16 口径在 CJK 断言场景等价。
- **「范围」配置的落地口径**：ticket 说「设置面板提供宏名与范围/上限配置」，实现上范围 = 表格启停（US13 既有能力，决策 7 定义参与 = 启用表），面板记忆宏组只放宏名 + 上限——避免与表格启停重复入口；如需独立表范围选择器属未来需求。
- **快照陈旧窗口**：面板记录增删改不 kick，变更后立即生成有 ≤2s 陈旧窗口（指纹轮询收敛）；手动验收路径用显式 kick 验证。判断满足规格意图（宏在生成时展开、2s 可接受），记录操作补 kick 留作后续。
- 手动验收（2026-08-11 真机重跑）：verify-memory-macro.mjs 7/7 + verify-ui-shell.mjs 33 项全绿（含修复后回归）。

- [ ] 宏展开输出当前记忆上下文（启用表分组 + 显示文本 + 上限截断）
- [ ] 宏名自定义生效；不放置宏则无注入
- [ ] 快照刷新时机正确（变更后重建）；组装逻辑为纯函数并有测试
- [ ] 输出格式符合格式契约（分组/空表省略/尾部截断标记）；上限默认 2000 字符可配置
- [ ] 手动验收：宏放入角色卡，真实生成时展开最新记忆
