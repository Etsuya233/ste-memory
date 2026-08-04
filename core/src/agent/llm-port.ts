import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * LLM 端口：pi 类型的一等公民组合（不包壳）。
 *
 * - `streamFn`：pi 的流式调用抽象，Agent 模块不感知厂商协议；
 * - `model`：pi 模型对象（含 provider/baseUrl/上下文窗口等元数据）；
 * - `getApiKey`：按 provider 动态解析 API Key（可省略，由模型自带配置兜底）。
 *
 * 具体 provider 构造、env 读取与配置合并由宿主（apps/api，11.5）实现，
 * 本模块只定义与消费该端口类型。
 */
export interface LlmPort {
  readonly streamFn: StreamFn;
  readonly model: Model<Api>;
  readonly getApiKey?: (provider: string) => string | Promise<string | undefined> | undefined;
}
