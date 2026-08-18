# Playwright 无头验证 SillyTavern 扩展

2026-08-08 首次用于 st-extension ticket 02 的手动验收替代/补充：headless chromium
真实加载 ST 页面，抓 Console 初始化日志 + 扩展管理器识别。本文记录可复用的套路与踩过的坑。

## 什么时候用

- 需要证据证明扩展在**真实 ST 环境**里加载成功（console 日志、DOM 出现、无报错），但不想/不能开有头浏览器
- 后续 ticket 的浏览器侧验收（面板打开、事件同步、宏展开等）可沿用同一模式：
  页面加载 → 等待/抓取特定 console 日志或 DOM 状态 → 截图留证

## 环境事实

- ST 以源码 checkout 方式运行（位置按本机环境自定，不在本仓库内）：`npm install && npm start`
  后监听 `127.0.0.1:8000`（ST 默认端口，可用 `ST_URL` 覆盖）；首次启动会把 default 内容铺到
  `data/default-user/`，日志出现 `SillyTavern is listening on IPv4: 127.0.0.1:8000` 表示就绪。
- 浏览器用 Playwright 缓存里的 chromium（不重新下载）：`verify.mjs` 自动扫描
  `~/.cache/ms-playwright/` 下最新的 `chromium-*/chrome-linux*/chrome`，也可用 `CHROME` 环境变量指定。
- 若本机配置了系统代理（clash 等），连本机服务一律要绕过（curl 用 `--noproxy "*"`）。

## 步骤

```bash
# 1. 一次性准备（playwright-core 很轻，不下载浏览器；--ignore-workspace 使其独立于仓库 workspace）
cd docs/playwright-st-extension
pnpm install --ignore-workspace

# 2. 确认 ST 在跑
curl -s -o /dev/null -w "%{http_code}\n" --noproxy "*" http://127.0.0.1:8000/

# 3. 跑验证脚本（exit 0 = 通过；截图输出到系统临时目录）
node verify.mjs
```

脚本做的事：

1. 自动发现缓存 chromium（`CHROME` 可覆盖），headless launch
2. `page.on("console"/"pageerror"/"requestfailed")` 全量收集
3. goto ST，**轮询**等待初始化日志（扩展是 module script 异步加载，`domcontentloaded` + 轮询
   比 `networkidle` 稳）
4. jQuery `trigger('click')` 打开扩展管理器弹层，数 `.extension_block` 并确认包含插件名
5. 汇报 pageerror / 失败请求（重点过滤 ste-memory 相关），截图留证

## 踩过的坑（按代价排序）

1. **代理导致 ERR_TIMED_OUT**（最大的坑）：headless chrome 继承系统代理环境变量后
   连 `127.0.0.1:8000` 直接超时。修复必须**同时**：
   - launch 参数 `args: ["--no-proxy-server"]`
   - `env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "" }`
   - 只设 Playwright 的 `proxy: { server: "direct://" }` 不够，实测仍超时。
2. **隐藏元素 click 超时**：`#extensions_details` 在隐藏菜单里，Playwright 的 click 等
   actionability 会等 15s 超时（locator 能解析到元素但点不了）。解决：`page.evaluate`
   里 `$('#extensions_details').trigger('click')` —— ST 用 jQuery `.on('click', ...)` 绑事件，
   trigger 无视可见性直接触发。弹层等 `.extensions_info` → `.extension_block` 出现。
3. **waitUntil 选择**：`networkidle` 在 ST 这种重页面会等很久甚至超时；`domcontentloaded`
   + 业务条件轮询（console 日志 / selector）才是正解。
4. **curl 也中代理**：裸 curl 127.0.0.1 返回 502，必须 `--noproxy "*"` 才能拿到真实状态码。

## ST 侧可用事实（验证用）

- 扩展发现 API：`GET /api/extensions/discover` → 数组含 `{"type":"global","name":"third-party/ste-memory"}`
- 扩展静态文件：`/scripts/extensions/third-party/ste-memory/{manifest.json,index.js,style.css}`
- 扩展管理器弹层：`#extensions_details` 点击触发（jQuery），内容含 `.extensions_info`、
  第三方扩展在 "Installed Extensions:" 段落的 `.extension_block`（含名字与启停开关）
- 插件初始化日志走 `console.info`，console 事件 type 为 `info`

## 遗留事项

- 脚本只验证「加载 + 识别」；后续 ticket（面板 UI、消息同步、宏展开）需要按各自验收标准
  扩展等待条件与 DOM 断言。
- 截图对 AI 阅读不友好（本模型看不了图），DOM 断言才是主证据，截图只给人看。

## ticket 15 验收脚本（verify-memory-macro.mjs）

```bash
node verify-memory-macro.mjs   # exit 0 = 全流程通过（7 项断言）
```

真实 ST 中走完「宏注册 → 快照预计算 → 数据变更后展开最新记忆 → 宏名自定义 → 上限截断 →
停用无注入」全流程（Windows 上 ST 数据目录不在默认路径时用 `STE_ST_DATA` 指定）：

1. 打开测试角色对话建空间 → 默认宏名 `{{memoryContext}}` 解析为裸标识符注册
   （`macros.registry.hasMacro` 断言；验证名字不带花括号）
2. 空库展开为空串（空表省略；宏仍注册 = 不放置宏则无注入）
3. 经插件运行时建记录（`__STE_MEMORY_RUNTIME__`，core 服务全链路）+ `macro.kick()` →
   宏引擎真实展开（`macros.engine.evaluate`）含分组标题与记录显示文本
4. 第二条记录：组内最新在前（新记录先于旧记录）
5. 设置上限 9 字符 + kick → 展开以「……（已截断）」结尾、总长 = 上限
6. 设置面板改宏名为 `{{myMemory}}`（React 受控输入用原生 setter 赋值）→
   旧名注销、新名注册且展开同样生效
7. 自清理：删除验收记录 + 恢复默认设置（等 2.5s 防抖落盘，保证下次运行起点干净）

踩过的坑（2026-08-11 首次全绿，Windows + headless chromium）：

- **宏引擎 env 不能传空对象**：`engine.evaluate(text, {})` 会先访问 `env.dynamicMacros`
  （`Object.hasOwn(undefined, ...)` 抛 TypeError → 引擎回退原文不展开）。最小 env =
  `{ dynamicMacros: {}, functions: { postProcess: (r) => r } }`（handler 不消费 env）。
- **验收数据必须经 core 服务写入**（运行时 `records.create`）：直接写 indexedDB 的行没有
  displayText/updatedAt，宏快照（复用显示策略）与指纹（变更检测）都不会反映。
- **清聊天文件残留 → 全新建空间**（与 verify-ui-shell 同法）；窗口内写设置后要等防抖落盘
  再结束，否则 settings.json 残留旧值影响下次运行。
- **`{{memoryContext}}` 默认值含花括号**：注册名是剥离后的裸标识符（ST 标识符规则
  字母开头 + 字母数字连字符），`hasMacro` 断言必须用裸名。

## ticket 06 验收脚本（verify-ui-shell.mjs）

```bash
node verify-ui-shell.mjs   # exit 0 = 全流程通过（23 项断言）
```

真实 ST 中走完「顶部按钮 → 面板骨架（移动抽屉/桌面浮动）→ 表格列表启停落库 → 设置面板
持久化与插件开关」全流程：

1. 插件加载（初始化日志）+ 打开测试角色对话自动建空间
2. 顶部工具栏按钮就位（#top-settings-holder 内）
3. 移动端（390px）全屏底部抽屉布局（computed style 断言）；桌面（1280px）浮动面板
4. 面板骨架：空间名称 + 底部 Tab 四枚（表格/记录/任务/设置）+ 8 张系统表 + 首个表格默认展开字段
5. 表格启停 → Dexie memoryTables.enabled 落库 + UI 开关反映
6. 停用显示策略依赖字段 → core 保护规则 toastr 报错、不落库；停用普通字段 → 落库
7. 记录 Tab 占位；设置 Tab：插件开关 + 版本 + 运行状态 + R2 占位（4 个禁用输入）+ 记忆宏占位（禁用 + 默认名）
8. 插件总开关关闭 → extensionSettings.steMemory.enabled 持久化 + 头部「插件已停用」；
   重新启用 → 恢复空间名
9. 收起按钮关闭面板 + 按钮 aria-pressed 同步；全流程无插件相关页面错误
10. 优化项回归（2026-08-08）：存量聊天（无绑定）打开即自动建空间 + 写绑定；
    点击表格行（非开关区域）展开/收起字段；移动端断言改为**实际绘制位置**
    （rect 覆盖整个视口，而非只看 computed style）——曾漏掉 ST 给 html 加
    `-webkit-transform: translateZ(0)` 导致 fixed 包含块变为 html、`bottom: 0`
    面板被顶出视口的真机 bug（修法：移动端改 `top: 0` 锚定，关闭态
    translateY(100%) 推屏下）

踩过的坑（2026-08-08）：

- **UI 首屏状态依赖对话绑定**：验收脚本必须先清掉测试角色的对话文件残留（含上次验收的
  chatMetadata 绑定指针），否则打开对话走的是 space-missing 分支（绑定在、本地库空），
  不会新建空间，表格列表无从渲染——与 verify-space-binding.mjs 同因。
- **indexedDB getAll() 按主键（UUID）排序，不是 createdAt**：验证「停用第一个表格落库」
  时不能从 getAll() 取 id 与 UI 首行对照，要从被点击的 DOM 元素 dataset 里取 id。
- **字段启停第一行是显示策略字段**：系统表显示策略引用 fields[0]（模板固定），停用它触发
  core 保护规则（memory_field_used_by_display_strategy）——验收脚本特意断言这条 toastr
  报错路径，再停第二个字段验证正常落库。
- **page.evaluate 谓词无法引用 Node 侧函数**：waitUntil 的谓词序列化进页面上下文，
  Dexie 快照断言要用 Node 侧轮询（waitForDbState：Node 循环里反复 readSteMemoryDb）。

## ticket 05 验收脚本（verify-space-binding.mjs）

```bash
node verify-space-binding.mjs   # exit 0 = 全流程通过（14 项断言）
```

真实 ST 中走完「打开对话建空间 → 发消息 → 新对话 → 切回 → 重命名 → 刷新不重建」全流程：

1. 插件加载（初始化日志）
2. 打开 Seraphina 对话 → 自动建空间 + chatMetadata 绑定 + 8 张系统表就位
3. 发消息（MESSAGE_SENT / MESSAGE_RECEIVED 已注册，无 LLM 后端时生成失败可接受）
4. 新对话 → 第二个空间；切回原对话 → 绑定不变、不重复建
5. 重命名对话 → 绑定跟随（同 spaceId）、空间显示名保持创建时值
6. 直接读对话文件 JSONL 第一行确认绑定随文件持久化
7. 刷新页面 → 再次打开不重复建

踩过的坑（2026-08-08）：

- **角色聊天目录名是 `chats/default_Seraphina/` 而非 `chats/Seraphina/`**——清理残留时要按
  `chats/*` 扫描含角色名的目录；聊天文件名（card 的 `chat` 字段）会跨运行残留，同名叠加
  「-已改名」后缀属正常现象，不影响断言。
- **ST 新版 Popup 是 `<dialog class="popup">`**，旧 `#popup` 选择器匹配不到；确认按钮
  为 `dialog.popup .popup-button-ok`。
- **角色列表/聊天切换都是异步的**：`characters` 在插件初始化日志后一段时间才就绪；
  `selectCharacterById` / `openCharacterChat` 在保存未完成时会静默跳过或延后生效——
  一律用轮询断言（chatId / 绑定值），不要依赖固定 sleep 或一次性调用。
- **日志断言要按「新日志计数」**：`waitForSteLog` 会匹配到历史日志，须记录操作前的
  日志总数再等新条目。

## ticket 16 验收脚本（verify-chat-metadata-mirror.mjs）

```bash
node verify-chat-metadata-mirror.mjs   # exit 0 = 全流程通过（17 项断言）
```

真实 ST 中走完「镜像写入 → 文件持久化 → 设置开关 → LWW/未知版本守卫 → 清库恢复 →
按空间恢复」全流程（2026-08-10 首次全绿，headless chromium）：

1. 打开对话建空间 → 镜像自动写回（27 KB 级：8 表 + 字段结构）→ 信封/spaceId/单元
   完整 + JSONL 首行落盘
2. 设置面板镜像组：状态行「上次写回 · N KB」+ 两个开关默认开启
3. 第二个对话：各自空间各自镜像（文件身份跟踪）
4. LWW：镜像 updatedAt 改为未来值 → 本地变更不覆盖 + warn「比本地数据新」
5. 未知版本（version 99）→ 原样保留 + warn「无法识别」
6. 镜像开关关闭 → 变更不写回（磁盘镜像 unchanged）；清库后打开对话不恢复
   （space-missing「数据未就绪」）；重新开启 → 恢复 + 头部标记
7. 按空间恢复：清库后先开对话 A 只恢复 A（B 不受伤），再开 B → 两空间并存
8. 全程无插件相关页面错误

踩过的坑（2026-08-10）：

- **indexedDB.deleteDatabase 会被插件活跃连接 blocked**：请求随页面销毁被丢弃，
  库根本没删。清库必须用事务内逐 store `clear()`（等价「本地库被清」，不受连接阻塞）。
- **evaluate 写设置 + 立即 reload 会丢设置**：saveSettingsDebounced 是 1s 防抖，
  reload 打断防抖 → 写入丢失（settings.json 里 steMemory 缺失，插件回退默认值，
  后续断言全部错位）。所有设置写入点必须等 2.5s 落盘再 reload。
- **面板 Tab 是条件渲染**：`toggleFirstTable` 会把面板切到表格 Tab，此时设置区块
  的 `toggle-mirror` 不存在，`?.click()` 静默空操作。切 Tab 操作前必须先切回目标 Tab
  并等目标元素出现。
- **restored 标记是瞬态**：`openChat` 触发的后续同步会把「已从文件镜像恢复」覆盖
  成普通状态（标记属于恢复那一次同步，与 created 同语义）。头部断言必须用
  MutationObserver 在 DOM 更新瞬间记录，不能事后读文本。另核实：reload 后 ST
  **不会**自动打开最后对话（boot 不触发恢复，恢复日志来自 openChat）。

## ticket 02 验收脚本（verify-memory-views.mjs）

```bash
node verify-memory-views.mjs   # exit 0 = 全流程通过（11 项断言）
```

真实 ST 中走完「建表建记录 → 设置面板级视图配置（settings.write + macro.kick）→
`{{memoryContext::视图名}}` 展开（in 多值筛选排除（含已放弃）+ 投影渲染 + 条数上限/ 倒序 + 无投影显示文本）→
无参宏回归 → 未知视图空串 → **世界书条目关键词触发注入**（getWorldInfoPrompt
dry run 真实路径：建书 → 条目内容放宏 → 分配给当前对话 → 剧情文本命中关键词 →
条目激活时宏展开）→ 设置面板记忆视图区块冒烟」全流程。

踩过的坑（2026-08-17）：

- **WI 书分配走 chat_metadata**：`getContext().getChatLore()` 直接读
  `chat_metadata.world_info`（world-info.js:4433），建书（saveWorldInfo +
  updateWorldInfoList）后赋值该键即可被扫描命中，无需 UI 操作。
- **createWorldInfoEntry 未暴露到 getContext**：条目对象手工构造（模板字段见
  world-info.js newWorldInfoEntryTemplate；缺失字段在 load 时自动补齐）。
- **dry run 扫描不写定时状态**：getWorldInfoPrompt(chat, maxContext, true)
  是插件 worldbook-text.ts 同款调用（ADR 0007），不会污染对话 sticky/cooldown。
