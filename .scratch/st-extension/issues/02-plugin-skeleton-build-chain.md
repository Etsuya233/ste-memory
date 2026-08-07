# 02 — 插件工程骨架与构建链

**What to build:** `apps/st-extension` 新包：TS 源码 + esbuild 打包为单文件（index.js + manifest.json + style.css）；dev watch 自动拷贝进 ST 的 `extensions/third-party/ste-memory/`；产物能被 ST 正常加载（扩展管理器识别、控制台出现插件初始化日志）；测试基建就位（vitest + fake-indexeddb）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 新包接入 monorepo（typecheck / lint / test / build 可在包内单独跑）
- [ ] esbuild 产物 = 单文件 js + manifest + css，无裸 node_modules import
- [ ] dev 脚本 watch + 拷贝进 ST 扩展目录
- [ ] 手动验收：ST 加载扩展成功，控制台有插件初始化日志
