# R2 云同步配置指南（ticket 08）

插件把记忆数据同步到 Cloudflare R2（S3 兼容对象存储）。配置四要素后自动生效：
**变更防抖推送**（每空间一个 JSON 文件 + 索引文件）、**空库启动自动拉取全量**、
**冲突 last-write-wins（较新版本胜出）**。本指南只讲 Cloudflare 侧的准备工作；
同步模型与文件格式见 `docs/adr/0022-r2-cloud-sync.md`。

## 1. 创建 Bucket 与 API 令牌

1. Cloudflare 控制台 → **R2** → **Create bucket**，起一个名字（如 `ste-memory-backup`）。
   记下 **Account ID**（R2 概览页右上角）。
2. R2 → **Manage R2 API Tokens** → **Create API Token**：
   - 权限选 **Object Read & Write**（对象读写；不要只给只读，否则推送 403）；
   - 作用域限定到刚才的 bucket（只读 token 无法同步，但可以安全地只用于排查）。
   - 生成后复制 **Access Key ID** 与 **Secret Access Key**（Secret 只显示一次）。
3. 在插件的「设置 → 云同步」填入 Account ID / Access Key ID / Secret Access Key / Bucket。
   四项填齐即自动启用同步，无需额外开关；密钥明文存在 ST 的 settings.json
   （本地单用户实验可接受，ADR 0017 精神）。

## 2. 配置 Bucket CORS（必须）

浏览器直连 R2 受 CORS 限制：不配置时请求会在预检阶段被拦，界面提示
「无法连接 R2（网络错误或 Bucket CORS 未配置）」。

**方式 A：控制台（推荐）**：R2 → Bucket → **Settings → CORS Policy** → 编辑 JSON：

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "authorization", "x-amz-content-sha256", "x-amz-date"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedOrigins` 建议收敛为你的实际来源（云酒馆地址、TauriTavern 的
WKWebView origin），调试期可用 `*`。`AllowedHeaders` 必须包含签名的三个
`x-amz-*` 头与 `authorization`、`content-type`（R2 对 `*` 通配的匹配有历史
兼容问题，显式列出最稳）。

**方式 B：S3 API（PutBucketCors）**，`aws cli` 已配好 R2 凭证时：

```sh
aws s3api put-bucket-cors \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --bucket <BUCKET> \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["content-type", "authorization", "x-amz-content-sha256", "x-amz-date"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }]
  }'
```

验证：`aws s3api get-bucket-cors --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --bucket <BUCKET>`。

## 3. 工作原理（简版）

- **对象布局**：每个记忆空间一个 `spaces/<spaceId>.json`（与导出备份同信封 +
  `spaceId`/`updatedAt`，`updatedAt` = 该空间最近一次变更时间，即 LWW 键）；
  另有一个 `index.json` 索引（spaceId + updatedAt 清单）。
- **推送**：数据变更（含记录/表格/字段增删改、导入恢复）经指纹检测（各表行数 +
  最大 updatedAt）→ 3s 防抖窗口合并 → 推送。推送前与云端索引比较：**云端较新则
  本地不覆盖**（较新版本胜出）；相同也跳过。先写空间文件、再写索引（失败重试，
  幂等覆盖）。
- **拉取**：本地库为空（新设备 / iOS 存储被清）时启动自动全量拉取，校验通过后
  整体原子恢复；本地有库则一律优先本地（离线可用）。
- **失败重试**：断网/配置错误在「同步状态」显示失败提示，按 10s 起指数退避
  （封顶 5min）自动重试；「立即同步」按钮强制跑一轮。
- **时间线**：最近同步时间与失败提示在设置面板「同步状态」组与面板头部可见。

## 4. 排查

| 现象 | 原因与处理 |
|---|---|
| 无法连接 R2（网络错误或 CORS 未配置） | 检查第 2 节 CORS；或确认网络可达 `*.r2.cloudflarestorage.com` |
| HTTP 403 | Access Key ID / Secret 错误，或令牌权限不是 Object Read & Write |
| HTTP 404（PUT） | Bucket 名错误或不存在；GET 404 属正常（对象尚未存在） |
| 面板显示「同步失败」但配置没问题 | 查看设置面板失败提示原文；`index.json` 被其他工具写过且版本不识别时，插件明确报「版本不支持」且不覆盖本地 |
| 「当前环境不支持 WebCrypto（非安全上下文）」 | 签名依赖 WebCrypto（`crypto.subtle`），仅安全上下文可用（https / localhost / tauri.localhost）；经 http + 局域网 IP 访问云酒馆时不可用 |

## 5. 手动验收（双端）

1. 真机（云酒馆）配置 R2 → 修改一条记忆 → 3s 内自动推送；
2. 用 `aws s3 ls --endpoint-url ... --recursive` 确认 `spaces/` 与 `index.json` 已生成；
3. 清空浏览器 IndexedDB（或换 TauriTavern 全新安装）→ 启动插件 → 自动拉取恢复；
4. 两端同时编辑同一空间的不同记录 → 较新一方胜出，无不可恢复分叉。
