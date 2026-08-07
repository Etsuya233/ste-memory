# 08 — R2 云同步

**What to build:** CloudSyncAdapter 接口 + Cloudflare R2 实现（S3 兼容签名、bucket CORS 配置说明、错误处理）；每记忆空间一个 JSON 文件 + 索引文件（版本号 + 更新时间，last-write-wins）；数据变更防抖周期推送；本地库为空时启动拉取全量；设置面板 R2 配置生效，同步状态（最近同步时间、失败提示）可见。

**Blocked by:** 06 — 基础 UI 壳与设置面板；07 — 手动导出/导入（复用序列化编解码）

**Status:** ready-for-agent

- [ ] 配置 R2 后变更自动防抖推送；断网/失败有提示且后续重试
- [ ] 空库启动自动拉取全量；本地有库则优先本地
- [ ] LWW 冲突语义正确（较新版本胜出）；适配器 mock fetch 测试通过
- [ ] 每空间云文件与索引文件带与导出相同的版本化信封（format/version 语义一致），未知版本明确报错不覆盖本地
- [ ] 手动验收：真实 R2 桶往返 + 双端（云酒馆/TauriTavern）恢复
