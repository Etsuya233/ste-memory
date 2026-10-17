/**
 * 提案工具错误：throw 后由 pi 转 isError 工具结果回喂模型自愈（与 query_records 一致）。
 */
export class ProposalToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalToolError";
  }
}
