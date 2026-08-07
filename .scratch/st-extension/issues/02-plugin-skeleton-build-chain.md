# 02 — 插件工程骨架与构建链

**What to build:** `apps/st-extension` 新包：TS 源码 + esbuild 打包为单文件（index.js + manifest.json + style.css）；dev watch 自动拷贝进 ST 的 `extensions/third-party/ste-memory/`；产物能被 ST 正常加载（扩展管理器识别、控制台出现插件初始化日志）；测试基建就位（vitest + fake-indexeddb）。

**Blocked by:** None — can start immediately

**Status:** resolved

## Answer

新包 `apps/st-extension`（`@ste-memory/st-extension`）就位，工程骨架 + 构建链全部落地：

- **包结构**：`src/`（浏览器侧，DOM lib、无 node 全局）与 `scripts/`（构建侧，node 环境）分开 typecheck（`tsconfig.json` + `tsconfig.scripts.json`）；`src/index.ts` 入口 → `bootstrap()`（ST 环境探测 + 初始化日志，日志注入可测）；`src/st-globals.ts` 走 ST 1.18 官方外部接线 `globalThis.SillyTavern.getContext()`（public/script.js 已核实），bundle 零 import、零 externals；`src/style.css` 只放 spec 约定的 `--stm-*` 设计令牌（唯一集中定义处）。
- **构建链（scripts/，Node 24 strip-types 直接跑）**：`build-lib.ts`（esbuild bundle → 单文件 index.js，esm/browser/es2020，版本号经 `define` 注入）、`build.ts`（产物 → dist/：index.js + manifest.json + style.css）、`dev.ts`（esbuild context watch + 静态资产 watcher，每次构建后同步进 ST 扩展目录）、`extension-target.ts`（目标目录解析 + 拷贝，纯函数可测）。
- **ST 目录配置**：`.env` 支持 `STE_ST_EXTENSION_DIR`（直接指向 `extensions/third-party/ste-memory`，优先）或 `STE_ST_INSTALL`（ST 安装根，自动推导 `public/scripts/extensions/third-party/ste-memory`）；缺配置时报错带指引。本机无 ST 安装，拷贝目标用临时目录实测通过。
- **测试（vitest + fake-indexeddb，node 环境）**：构建链验收（产物三件套、无裸 import / node_modules 路径、manifest 与 package.json 版本一致且注入 bundle）、目标目录解析与拷贝、bootstrap 日志行为、fake-indexeddb 基建冒烟（写入/读取往返，供 ticket 03 的 Dexie 测试使用）。
- **验证**：包内 test 11/11 绿（含 dev 构建 sourcemap 清理用例）；全仓 typecheck 绿；全仓 build（api/web/st-extension）绿；全仓 eslint 0 问题（本包无新增告警）；根 vitest（排除 tmp/.worktrees 干扰后）53 文件 277 用例全绿（含本包 4 个新测试文件；首轮 3 个失败为既知并行负载抖动，复跑消失）。dev watch 实测：src 变更重建、css/manifest 变更即时同步、目标目录落盘正确；修复了重建同步覆盖刚拷贝静态资产的反向竞争（重建前先刷新 dist 静态资产），prod 构建会清理 dev 残留的 sourcemap。
- **手动验收（已执行 2026-08-08）**：ST 1.18.0 跑在 `tmp/SillyTavern_Source_Code`（本机 127.0.0.1:8000），dev watch 把产物同步进 `public/scripts/extensions/third-party/ste-memory/`；服务端验证：manifest/bundle/css 均可访问、`/api/extensions/discover` 返回 `third-party/ste-memory`；浏览器验证：扩展管理器出现 STE Memory，F12 Console 出现 `[STE Memory] v0.1.0 已加载（SillyTavern UI Extension）`。
- 附带：pnpm-workspace.yaml 的 `allowBuilds` 增加 `esbuild: true`（pnpm 11 拦截 esbuild postinstall 导致所有 pnpm 命令报错）。

- [x] 新包接入 monorepo（typecheck / lint / test / build 可在包内单独跑）
- [x] esbuild 产物 = 单文件 js + manifest + css，无裸 node_modules import
- [x] dev 脚本 watch + 拷贝进 ST 扩展目录
- [x] 手动验收：ST 加载扩展成功，控制台有插件初始化日志（2026-08-08 真机验证通过：扩展管理器识别 + Console 出现 `[STE Memory] v0.1.0 已加载`）

## Comments

- 2026-08-08 code-review 反馈处理：esbuild 配置去重（`createEsbuildOptions` 供 build/dev 共用）；包内 `lint` 脚本补上；prod 构建清理 dev sourcemap 残留；st-globals 注释去掉对 tmp 路径的引用；清单合并为单份勾选。
- 2026-08-08 手动验收完成：本机 ST 1.18.0（tmp/SillyTavern_Source_Code，127.0.0.1:8000）+ dev watch 实测，扩展管理器识别 STE Memory，Console 出现初始化日志，ticket 02 四项全部闭环。
