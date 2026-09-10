# 03 — Agent 请求行流（消息去重、思考、输出、工具）

**What to build:** 每次 LLM 请求在日志里一条 `fill-agent` 行，完整呈现 Agent 的决策轨迹：本轮新增消息、思考、输出文本、停止原因、token 用量、工具调用参数；工具结果出现在下一请求行。每批首条请求带系统提示词与预设消息快照，历史上下文不重复记录——批内拼接即该批完整 Prompt 轨迹。运行中或事后都能看到思考与工具过程。

**Blocked by:** 02 — 填表生命周期行流（任务结束 + 每批开始/结束，边跑边写）。

**Status:** ready-for-agent

- [ ] 每次 LLM 请求完成时即时写入 `fill-agent` 行：batch、block、round（批内从 1 递增）、messages（相对上一条新增的原始消息对象）、output（thinking、text、stopReason、usage、toolCalls 含 id/name/args）。
- [ ] 每批首条请求行的 messages 含预设消息与本批消息，并带 systemPrompt（该批完整系统提示词快照）；后续请求行只含新增内容（上一轮工具结果），不重复历史上下文与系统提示词。
- [ ] 工具结果落在下一请求行的 messages；若运行结束时仍有未落入请求行的消息（工具执行后直接结束），写入所在批结束行的 trailingMessages。
- [ ] 填表 LLM 端口开启思考捕获；模型不支持时静默降级、不报错、不阻断任务。
- [ ] 失败轮的请求行级别为 error，其余为 info；失败与中断任务中已发生的请求行均落库。
- [ ] 测试通过：`FillTaskService` 集成测试断言成功任务各请求行内容（思考、输出、用量、工具调用参数）、批内去重、工具结果落位、trailingMessages 兜底与失败轮级别。

**参考**：本目录 `../spec.md`；决策见 ADR 0016。
