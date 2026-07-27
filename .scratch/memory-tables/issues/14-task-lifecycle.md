# 14 — 提供任务轮询、暂停、恢复和中止

**Type:** task

**What to build:** 完成后台任务状态机和 Web 轮询控制，支持安全暂停、恢复和中止；控制只在工具轮次之间或提交前生效，不强行打断正在运行的 LLM 请求或 SQLite 事务。

**Blocked by:** 13 — 正式提交一个消息范围的后台处理任务

**Status:** ready-for-agent

- [ ] 任务至少支持 queued、running、pause_requested、paused、cancel_requested、cancelled、succeeded、failed、interrupted。
- [ ] 页面轮询显示当前状态、已处理来源数、总来源数、警告、错误和最近更新时间。
- [ ] 暂停请求在安全点生效，暂停期间可查看目标表但不能手动修改目标空间。
- [ ] 恢复从同一 run 的未完成安全点继续，不重复提交已成功的原子批次。
- [ ] 中止请求在安全点生效；未提交提案被丢弃，正在进行的事务等待真实结果后再确定状态。
- [ ] 任务运行时其他记忆空间仍可查看和手动编辑。
- [ ] API 重启后所有非终态任务标记为 interrupted，不自动重放。
- [ ] 前端能区分请求中与最终状态，避免重复暂停/中止提交。
