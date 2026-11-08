import type { LogRepository } from "../logging/log.ts";
import { errorDetails } from "../logging/error-details.ts";

export class ImportFailure extends Error {
  readonly operationId: string;
  constructor(operationId: string, phase: ImportPhase, cause: unknown) {
    super(
      `导入操作：${operationId}\n阶段：${importPhaseNames[phase]}\n${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ImportFailure";
    this.operationId = operationId;
  }
}

const importPhaseNames = {
  "read-backup": "读取备份",
  preview: "预览备份",
  "macro-validation": "检查宏配置",
  clone: "准备导入副本",
  "database-validation": "校验表格数据",
  "stop-writes": "停止旧空间任务",
  activate: "载入导入内容",
  "save-confirm-retire": "保存、核验聊天文件并清理旧资源",
  refresh: "刷新工作台",
} as const;
export type ImportPhase = keyof typeof importPhaseNames;

/** 一次预览和执行共用操作编号，阶段只用于诊断，不参与空间状态判断。 */
export class ImportDiagnostic {
  readonly id = `import-${crypto.randomUUID()}`;
  private phase: ImportPhase = "read-backup";
  private readonly started = performance.now();
  private phaseStarted = this.started;
  private writes: Promise<void> = Promise.resolve();
  private details: Record<string, unknown>;
  private readonly logs: LogRepository;
  constructor(logs: LogRepository, target: string | undefined, appVersion: string) {
    this.logs = logs;
    this.details = { target, appVersion };
    this.write("info", "start");
  }
  describe(details: Record<string, unknown>): void {
    Object.assign(this.details, details);
  }
  stage(phase: ImportPhase): void {
    this.write("info", "stage-complete");
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.write("info", "stage-start");
  }
  async complete(): Promise<void> {
    this.write("info", "complete");
    await this.writes;
  }
  warning(message: string): void {
    this.write("warn", "cleanup-warning", message);
  }
  async failed(error: unknown): Promise<ImportFailure> {
    this.write("error", "failed", error);
    await this.writes;
    return new ImportFailure(this.id, this.phase, error);
  }
  private write(level: "info" | "warn" | "error", event: string, error?: unknown): void {
    const text = JSON.stringify(
      {
        ...this.details,
        operationId: this.id,
        phase: this.phase,
        event,
        elapsedMs: Math.round(performance.now() - this.started),
        stageMs: Math.round(performance.now() - this.phaseStarted),
        ...(error === undefined ? {} : { error: errorDetails(error) }),
      },
      null,
      2,
    );
    this.writes = this.writes
      .then(() => this.logs.append({ type: "memory-import", key: this.id, level, text }))
      .catch((cause) => {
        console.error("导入诊断日志写入失败", cause);
      });
  }
}
