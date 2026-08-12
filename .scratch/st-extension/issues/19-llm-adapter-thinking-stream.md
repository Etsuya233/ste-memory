# 19 — LLM 适配器思考流（includeReasoning 选项）

**What to build:** st-backends LLM 适配器支持思考流：适配器与请求体增加 `includeReasoning` 选项（缺省 false），开启后请求带 `include_reasoning: true`，SSE 解析把上游思考段累积为 pi `ThinkingContent` 块并发射 `thinking_start / thinking_delta / thinking_end` 事件；缺省时行为与现状一致。问答面板（ticket 20）依赖本票；填表任务零变化。

**Blocked by:** 无（复用 ticket 12 LLM 适配器）

**Status:** ready（grilling 2026-08 确认，待实现）

## 已确认决策（grilling 2026-08）

1. **按消费者开关（Q14）**：`StBackendsLlmAdapterOptions.includeReasoning?: boolean`（缺省 false）+ `buildStGenerateBody` 对应参数；填表任务不传 → 请求体与流解析行为零变化，现有测试原样绿。
2. **思考段解析（两形状）**：上游两种字段都要处理——`delta.thinking`（Claude 风格）与 `reasoning_content`（OpenAI 兼容推理模型）；累积为独立 `ThinkingContent` 块（与文本块并列），发射 `thinking_start / thinking_delta / thinking_end`（pi-ai 0.83 原生事件类型，已核实 dist/types.d.ts:393-405）。
3. **不污染既有累积**：思考块不得进入 content 文本累积（`#appendText`）与 tool_calls 累积（`toolcall_delta`）；穿插顺序（thinking 在 tool_use 前后）按 contentIndex 隔离。
4. **usage 恒 0 取舍不变**：ST 流不透出用量（含思考 token），维持 ZERO_USAGE。
5. **多轮回传剥离思考块**：思考块不随历史回传（无 thinkingSignature 且避免上下文膨胀）——ticket 20 历史组装处剥离。
6. **静默降级**：模型/后端不支持思考时 include_reasoning 无害（ST 侧忽略、上游无思考段），不报错。

## 结构

- `llm/st-backends-request.ts`：`StGenerateBody.include_reasoning` 类型放宽为 `boolean`；`buildStGenerateBody` 加参数（缺省 false）
- `llm/st-backends-llm.ts`：`StBackendsLlmAdapterOptions.includeReasoning`；流解析加思考累积与事件发射
- 测试：`st-backends-request.test.ts`（include_reasoning 请求形状）；`st-backends-llm.test.ts`（Claude 风格 / reasoning_content 风格 / 与 tool_calls 穿插 / 缺省 false 零变化）；`st-backends-agent-loop.test.ts`（填表任务回归原样绿）

## 验收（手动）

1. 填表任务在升级后行为与升级前一致（缺省关，自动化回归覆盖）
2. 问答面板（ticket 20）开启 includeReasoning 后，思考模型流式显示思考段；非思考模型无思考段、不报错

## Comments

- 2026-08 grilling（grill-with-docs）确认：Q3=B（思考流）、Q14=B（按消费者开，缺省 false——填表任务零变化是独立成票的动机：适配器是共享件，runtime.ts:175 唯一 LLM 端口、buildStGenerateBody 写死 include_reasoning: false、流解析只消费 delta.content/tool_calls，开思考流天然牵动填表任务，故默认关 + 独立回归）。
