export interface RerankPort {
  /** Returns exactly one finite score per document, in original document order. */
  rerank(
    query: string,
    documents: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly number[]>;
}

export function validateRerankScores(scores: readonly number[], count: number): void {
  if (
    !Array.isArray(scores) ||
    scores.length !== count ||
    scores.some((score) => !Number.isFinite(score))
  )
    throw new Error("重排服务必须返回每条候选的完整有限分数");
}
