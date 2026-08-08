# 05 — 空间绑定与 ST 事件桥

**What to build:** ST 环境适配器（getContext 包装 + 事件桥：CHAT_CHANGED 用于切换空间上下文；MESSAGE_SENT / MESSAGE_RECEIVED 仅注册为未来自动填表的触发点，当前无消费方）；记忆空间绑定存 chatMetadata（随对话文件走，重命名不丢）；首次打开对话自动创建记忆空间并从共享包安装七张系统表；向 UI 提供「按楼层跳转 ST 消息」能力（证据楼层 chip 的底层）。

**不做消息「同步步骤」**：消息全文不落库（ADR 0003），楼层范围随时从 ST 对话实时读取，无同步游标；「哪些楼层已填表」由填表任务的楼层进度台账维护（见 13），本票不记录楼层状态。

**Blocked by:** 01 — 系统表模板收编共享包；02 — 插件工程骨架与构建链；03 — Dexie 持久层（一）

**Status:** resolved

## Answer

`apps/st-extension/src/` 新增三层：纯逻辑 seam（`space-binding/chat-space-manager.ts`）+ ST 宿主适配器（`st/st-chat-adapter.ts`、`st/floor-jump.ts`）+ 组合根（`runtime.ts`，bootstrap 接线），全部验收项闭环：

- **ChatSpaceManager（纯逻辑层 seam，spec 测试决策的唯一 seam）**：首次打开对话自动建空间 + 安装系统表（共享包 `SystemMemoryTableInstaller`，8 张含世界状态表）+ 最后写绑定（「绑定存在 = 空间与表就绪」不变量；安装失败回滚空间并抛错，下次重试）；再次打开/切对话按绑定激活不重复建；chatId 无值（临时/未保存对话）→ `unsaved-chat`（面板文案「当前对话未保存，暂不支持记忆」）不报错；绑定在但空间不在本地库（新设备/本地库被清）→ `space-missing`，保持绑定不重建（云同步 ticket 08 拉取后恢复，spec「空库期间显示同步中状态而非报错」）。空间名 = 群聊「群聊 - 对话文件名」/ 单人「角色名 - 对话文件名」（超长文件名截断到 memorySpaceName 的 120 上限）；同步串行化 + 同步期间切走时回滚孤儿空间、绝不把旧对话绑定写进新对话 metadata。状态订阅（`getStatus` / `onStatusChange`）供 ticket 06 面板消费。
- **StChatAdapter（宿主薄层）**：**关键事实——ST 的 getContext() 每次调用构造新对象，切对话时 `chat_metadata` 整体替换**，因此适配器持有 getContext 工厂而非一次性快照，每次读写重取（测试抓到该坑：快照式实现会把旧对话绑定写进新对话）。`chat_metadata.steMemory = { version: 1, spaceId }` 小指针（键与 ST 既有 metadata 键无冲突），写入即 `saveMetadataDebounced` 持久化（随聊天文件走，重命名自动跟随——已由真机验收 + 文件级断言证明）。
- **事件桥**：`CHAT_CHANGED` → 重新同步空间上下文；`MESSAGE_SENT` / `MESSAGE_RECEIVED` 仅注册为 ticket 13 未来自动填表的触发点（无消费方，payload 一律忽略，隔离 ST 内部变更）。事件名走 `context.eventTypes`，不硬编码。
- **楼层跳转能力（证据楼层 chip 底层）**：纯判定 `resolveFloorJump`（越界/空对话/非整数 → out-of-range 带 chatLength）+ DOM 部分（ST 自身 /scroll-to-message 同法：`#chat` 容器内相对滚动 + `.mes[mesid=N]` 高亮 `stm-floor-flash`，令牌描边动效尊重 reduced-motion；非浏览器环境/块未加载 → not-loaded）。ST DOM 不测（测试决策），判定逻辑独立测试。
- **runtime.ts 组合根**：Dexie 四 repo + core 服务（id 工厂 `crypto.randomUUID`，非安全上下文降级时间戳+随机）+ 安装器 + 适配器 + 事件桥 + 启动同步；`bootstrap` 的 `start` 选项可注入（测试 fake），`PluginLog` 补 error。
- **测试（包内 87/87 绿，全仓 354/354 绿，typecheck/lint/build 全绿）**：floor-jump 纯判定；adapter（快照重取、绑定读写+防抖触发、损坏绑定值 → unrecognized 防御、三事件注册与 payload 忽略、越界/not-loaded）；manager 17 例（12 状态机：首次建空间+8 表+绑定、刷新重开不重复、重命名绑定跟随且显示名保持、切对话换空间、群聊命名、未保存对话、space-missing 保持绑定、绑定无法识别不覆盖、跨角色同名文件互不冲突、安装失败回滚重试、同步期间切走不污染、订阅/退订；5 命名纯函数含 UTF-16 截断口径）；runtime 组合根 3 例（全流程、CHAT_CHANGED 切换 + 消息事件无消费方、未保存对话）；bootstrap 3 例（loaded + 启动运行时、启动失败记 error、unavailable 不启动，注入 fake start 不依赖真实 runtime）。fake ST 上下文复用真实 adapter 的绑定读写，避免 fake 漂移。
- **手动验收（2026-08-08 真机，`docs/playwright-st-extension/verify-space-binding.mjs` 14 项全过）**：真实 ST 1.18（tmp/SillyTavern_Source_Code）中——打开 Seraphina 对话自动建空间（控制台「已为对话「…」创建记忆空间「…」」）→ chatMetadata 绑定写入 → IndexedDB 8 张系统表就位 → 发消息事件桥不抛错 → 新建对话建第二个空间 → 切回原对话绑定不变不重复建 → 重命名对话绑定跟随（同 spaceId）、空间显示名保持创建时值 → **对话文件 JSONL 第一行 chat_metadata.steMemory 落盘确认（绑定随文件走）** → 刷新页面再次打开不重复建。附：踩坑记录（角色目录名 `chats/default_Seraphina/`、新版 `<dialog class="popup">`、ST 异步切换需轮询断言）已写入 playwright 文档。

## Checklist

- [x] 打开已有对话自动建空间、系统表就位；再次打开不重复建（manager 测试 + 真机刷新验证）
- [x] 重命名对话后绑定不丢（chatMetadata 指针生效；真机文件级断言 + manager 测试）
- [x] 切对话切换空间上下文（CHAT_CHANGED；runtime 测试 + 真机切回验证）
- [x] 手动验收：真实 ST 中打开对话建空间、发消息、切对话、重命名全流程（2026-08-08，14 项断言全过）
- [x] 群聊：按对话文件绑定（群聊有 chatId）；空间名 = 「群聊 - 对话文件名」（群聊无角色名；manager 测试）
- [x] chatId 为 undefined（临时/未保存对话）：跳过绑定，面板提示「当前对话未保存，暂不支持记忆」，不报错（manager + runtime 测试）
- [x] 对话重命名：绑定跟随（chatMetadata 在文件内），空间显示名保持创建时值；跨角色同名对话文件互不冲突（绑定靠指针，名字只是显示；manager 测试）

## Comments

- 2026-08-08 code-review（双轴并行）结论：Standards 无硬违规、Spec 无 blocker。采纳四条修复：①空间名截断口径改与 core 校验一致（UTF-16 `slice(0,120)`，此前按码点截断在 emoji 密集文件名下仍会超限导致建空间抛错）；②绑定读取改三态（bound / unrecognized / none）——无法识别的绑定值（损坏/未来版本）原样保留，绝不当作无绑定去新建覆盖（防插件降级丢指针），新增 `binding-unrecognized` 状态与用例；③楼层跳转 smooth 滚动尊重 prefers-reduced-motion（CSS 动画原本已禁用，滚动未门控）；④bootstrap 测试注入 fake start（不再隐式依赖「真实 runtime 在 node 环境恰好不碰 IndexedDB」）。未采纳（判断级，记录）：`version: 1` 字面量在 adapter/manager/测试间的重复（字面量类型本身即约束）；ADR 0002 文档仍提及已取消的同步游标（开工规则不改 ADR，留待后续统一）。
- 2026-08-08 真机验收踩坑（已入 playwright 文档）：①ST 的 `getContext()` 每次构造新对象、切对话 `chat_metadata` 整体替换 → 适配器必须持 getContext 工厂（快照式实现会被 manager 测试的「同步期间切走」用例抓出）；②`characters`/聊天切换全异步，脚本断言必须轮询；③新版 Popup 是 `<dialog class="popup">`；④角色聊天目录名是 `chats/default_Seraphina/`。
- 遗留记录：真机验收中发现 ST 角色卡持久化 `chat` 字段（最后打开的对话名），跨验收运行残留导致对话名叠加「-已改名」后缀——纯测试环境现象，不影响产品逻辑（空间显示名保持创建时值，验收正是靠它证明的）。楼层跳转 v1 限制：ST 的 showMoreMessages 不在 getContext 公开面，长对话中目标楼层未渲染时返回 not-loaded 由 UI 提示，不自动加载更多消息。
