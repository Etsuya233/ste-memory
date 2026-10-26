import type { MemorySpaceBackup } from "../backup/backup-file.ts";

export interface SemanticScoreRow {
  readonly recordId: string;
  readonly score: number;
  readonly groupKey: string;
}
export interface SemanticSqlSourceRequest {
  readonly table: string;
  readonly groups: readonly string[];
  readonly query: string;
}
export interface PreparedSemanticSqlSource extends SemanticSqlSourceRequest {
  readonly rows: readonly SemanticScoreRow[];
}
export interface SemanticSqlEvaluationInput {
  readonly sessionId: string;
  readonly sql: string;
  readonly lastUserMessage?: string | null;
  readonly sources: readonly PreparedSemanticSqlSource[];
  /** The caller passes the remaining cumulative SQL budget on each execution. */
  readonly budgetMs?: number;
  readonly remainingMs?: number;
  readonly prepareOnly?: boolean;
}
export type SemanticSqlEvaluationResult =
  | {
      readonly status: "complete";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly unknown[])[];
      readonly usesSemantic: boolean;
      readonly elapsedMs: number;
    }
  | {
      readonly status: "needs-semantic-source";
      readonly request: SemanticSqlSourceRequest;
      readonly elapsedMs: number;
    };
export interface SemanticSqlEvaluationPort {
  openEvaluation(snapshot: MemorySpaceBackup): Promise<string>;
  evaluateSemanticSql(input: SemanticSqlEvaluationInput): Promise<SemanticSqlEvaluationResult>;
  closeEvaluation(sessionId: string): Promise<void>;
}
