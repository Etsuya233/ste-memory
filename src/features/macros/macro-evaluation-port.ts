import type { MemorySpaceBackup } from "../backup/backup-file.ts";

export interface MacroScoreRow {
  readonly recordId: string;
  readonly score: number;
  readonly groupKey: string;
  readonly rank?: number | null;
  readonly rerankScore?: number | null;
  readonly rerankRank?: number | null;
}
export interface MacroSqlSource {
  readonly name: string;
  readonly rows: readonly MacroScoreRow[];
}
export interface MacroSqlResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}
export interface MacroSqlEvaluationInput {
  readonly sessionId: string;
  readonly sql: string;
  readonly bind?: readonly (string | number | null)[];
  readonly lastUserMessage?: string | null;
  readonly sources: readonly MacroSqlSource[];
  readonly budgetMs?: number;
  readonly remainingMs?: number;
  /** Compile and authorize without stepping SQL or making an embedding request. */
  readonly prepareOnly?: boolean;
}
export interface MacroSqlEvaluationPort {
  openEvaluation(snapshot: MemorySpaceBackup): Promise<string>;
  evaluateMacro(input: MacroSqlEvaluationInput): Promise<MacroSqlResult>;
  closeEvaluation(sessionId: string): Promise<void>;
}
