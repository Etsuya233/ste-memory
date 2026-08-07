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
