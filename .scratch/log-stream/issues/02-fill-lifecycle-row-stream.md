# 02 — 填表生命周期行流（任务结束 + 每批开始/结束，边跑边写）

**What to build:** 填表任务运行过程中，日志页持续出现新行：`fill-task` 结束行、每批的 `fill-run` 开始/结束行（批号、楼层区间、状态、耗时、错误信息）。不必等任务结束——运行中手动查询就能看到已完成批次；失败批次与中断任务以对应级别呈现。所有填表行都是 Pretty JSON 文本。

**Blocked by:** 01 — 独立日志库与日志查询页（写入任务开始行）。

**Status:** ready-for-agent

- [ ] 任务结束时写入 `fill-task` 结束行：status（成功/失败/中断）、errorMessage（无错误为 null）、endedAt、durationMs。
- [ ] 每批开始时即时写入 `fill-run` 开始行：batch 序号、block 楼层区间、startedAt。
- [ ] 每批结束时即时写入 `fill-run` 结束行：batch、block、status、errorMessage、endedAt、durationMs。
- [ ] 级别映射：开始行 info；批/任务结束行按 succeeded/failed/interrupted = info/error/warn。
- [ ] 边跑边写且 best-effort：每行立即落库、写入失败只记警告不阻断任务；任务运行中查询可见已完成的行，按 Key 查询即为该任务的时间序。
- [ ] 失败任务能看到出错批的结束行与任务结束行的失败原因；取消（中断）任务能看到已完成行与中断状态。
- [ ] 初始化填表同样产生任务与批次生命周期行（省略楼层区间）。
- [ ] 填表行文本均为 Pretty JSON，可直接阅读。
- [ ] 测试通过：`FillTaskService` 集成测试（脚本化 LLM）断言成功/失败/中断任务的生命周期行顺序、内容与级别。

**参考**：本目录 `../spec.md`；决策见 ADR 0016。
