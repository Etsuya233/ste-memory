# 首个 Agent 只接入 OpenAI-Compatible Tool Calling

应用层通过厂商无关端口调用模型，首个实验只实现 OpenAI-Compatible 且支持 Tool Calling 的模型 Adapter。多次只读查询和最终原子变更批次依赖工具调用能力；其他厂商原生协议及 JSON-only fallback 等到实验验证后再扩展。
