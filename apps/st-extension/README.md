# @ste-memory/st-extension

SillyTavern 记忆表格插件（UI Extension）。纯前端：manifest + esbuild 单文件 bundle，只复用
core（打包进浏览器），不依赖 apps/api 与 apps/web（ADR 0001）。架构与术语见
`apps/st-extension/CONTEXT.md` 与 `apps/st-extension/docs/adr/`。

## 开发

```bash
pnpm install
pnpm --filter @ste-memory/st-extension build      # 产物 → dist/（index.js + manifest.json + style.css）
pnpm --filter @ste-memory/st-extension typecheck   # tsc（src 浏览器侧 + scripts 构建侧）
pnpm --filter @ste-memory/st-extension test        # vitest（node 环境 + fake-indexeddb）
```

## dev watch（自动拷贝进 ST）

1. 在 `apps/st-extension/.env` 配置 ST 安装位置（二选一，参考 `.env.example`）：
   - `STE_ST_EXTENSION_DIR`：直接指向 `extensions/third-party/ste-memory` 目录（优先）
   - `STE_ST_INSTALL`：SillyTavern 安装根目录（自动推导
     `public/scripts/extensions/third-party/ste-memory`）
2. 运行 `pnpm --filter @ste-memory/st-extension dev`。

watch 模式下 esbuild 监听 src 变化重建 bundle，并把 dist 产物同步进 ST 扩展目录；
`manifest.json` 与 `src/style.css` 的变化也会即时同步。扩展以 module script 加载，
改动后需刷新 ST 页面。

## 手动验收（ST 加载）

- ST 扩展管理器中应出现 **STE Memory**，可启用/禁用
- 浏览器控制台出现 `[STE Memory] vX.Y.Z 已加载（SillyTavern UI Extension）` 日志
- 打开已有对话：控制台出现 `已为对话「…」创建记忆空间「…」`（首次）——空间绑定存
  chatMetadata（`steMemory` 键），重命名对话不丢；切对话自动切换空间上下文
- 空间绑定全流程验收脚本：`docs/playwright-st-extension/verify-space-binding.mjs`（14 项断言）

## 发布到 GitHub（SillyTavern 在线安装）

ST 通过「仓库 URL + 分支」安装插件，分支根目录必须存在 `manifest.json`，安装后以 git pull 更新。
发版走 `release/sillytavern-plugin` 分支（**构建产物分支**，由脚本重生成，不手工 merge）：

```bash
# 1. 在 main 上把 apps/st-extension/package.json 的 version 更新为新版本号（唯一版本真相，
#    构建时注入 __STE_MEMORY_VERSION__；产物 manifest.json 的 version 由发版脚本自动回写对齐）
# 2. 提交合并到 main 后，执行：
pnpm release:st            # 构建 → 重生成 release 分支 → 本地 commit（不 push）
pnpm release:st --push    # 上述 + push 远端 release/sillytavern-plugin
pnpm release:st --dry-run # 只构建与暂存，不 commit / 不 push
```

用户安装：扩展 → Install extension → URL `https://github.com/Etsuya233/ste-memory` +
Branch or tag name `release/sillytavern-plugin`。更新走扩展面板的 Update 按钮
（按 commit 对比，push 到 release 分支即提示更新；`auto_update` 决定是否每日自动检查）。

注意：同一仓库只能同时装一个分支（插件目录名 = 仓库名），换渠道用「Switch branch」按钮。
