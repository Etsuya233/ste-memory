# Playwright 无头验证 SillyTavern 扩展（经验记录）

2026-08-08 首次用于 st-extension ticket 02 的手动验收替代/补充：headless chromium
真实加载 ST 页面，抓 Console 初始化日志 + 扩展管理器识别。本文记录可复用的套路与踩过的坑。

## 什么时候用

- 需要证据证明扩展在**真实 ST 环境**里加载成功（console 日志、DOM 出现、无报错），但不想/不能开有头浏览器
- 后续 ticket 的浏览器侧验收（面板打开、事件同步、宏展开等）可沿用同一模式：
  页面加载 → 等待/抓取特定 console 日志或 DOM 状态 → 截图留证

## 环境事实（本机）

- ST 源码 checkout 在 `tmp/SillyTavern_Source_Code`（gitignored），`npm install && npm start`
  后监听 `127.0.0.1:8000`；首次启动会把 default 内容铺到 `data/default-user/`，日志里有
  `SillyTavern is listening on IPv4: 127.0.0.1:8000` 表示就绪。
- Playwright 浏览器已缓存在 `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
  （版本目录号随 playwright 升级变化，先 `ls ~/.cache/ms-playwright/` 确认）。
- **本机有 clash 代理**（`http_proxy`/`HTTPS_PROXY`/`ALL_PROXY` → `172.26.176.1:7890`），
  连本机服务一律要绕过（curl 用 `--noproxy "*"`）。

## 步骤

```bash
# 1. 一次性准备（playwright-core 很轻，不下载浏览器）
mkdir -p /tmp/pw-check && cd /tmp/pw-check
npm init -y >/dev/null && npm install playwright-core --no-audit --no-fund

# 2. 确认 ST 在跑
curl -s -o /dev/null -w "%{http_code}\n" --noproxy "*" http://127.0.0.1:8000/

# 3. 跑验证脚本（模板：tmp/st-verify/verify.mjs，gitignored 本地留存）
cd /home/etsuya/programming/ste-memory/tmp/st-verify
node verify.mjs   # exit 0 = 通过；截图 st.png
```

脚本做的事：

1. launch chromium（`executablePath` 指向缓存二进制，headless）
2. `page.on("console"/"pageerror"/"requestfailed")` 全量收集
3. goto ST，**轮询**等待初始化日志（扩展是 module script 异步加载，`domcontentloaded` + 轮询
   比 `networkidle` 稳）
4. jQuery `trigger('click')` 打开扩展管理器弹层，数 `.extension_block` 并确认包含插件名
5. 汇报 pageerror / 失败请求（重点过滤 ste-memory 相关），截图留证

## 踩过的坑（按代价排序）

1. **代理导致 ERR_TIMED_OUT**（本次最大的坑）：headless chrome 继承 clash 代理环境变量后
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

- 脚本只验证「加载 + 识别」；后续 tickt（面板 UI、消息同步、宏展开）需要按各自验收标准
  扩展等待条件与 DOM 断言。
- 截图对 AI 阅读不友好（本模型看不了图），DOM 断言才是主证据，截图只给人看。
