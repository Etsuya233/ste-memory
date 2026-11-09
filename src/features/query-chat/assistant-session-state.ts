import type { AssistantSession } from "./session-store.ts";

export type AssistantOperationPhase =
  "saving-checkpoint" | "waiting-for-lock" | "owned" | "finishing";

export type AssistantExecutionState =
  | "idle"
  | "saving-checkpoint"
  | "waiting-for-lock"
  | "preparing-local"
  | "running-local"
  | "committing-local"
  | "finishing-local"
  | "running-elsewhere"
  | "committing-elsewhere";

export type AssistantActionBlockCode =
  | "session-busy"
  | "waiting-for-lock"
  | "running-elsewhere"
  | "committing"
  | "commit-uncertain"
  | "preview-required"
  | "empty-proposal"
  | "not-running";

export type AssistantActionAvailability =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: AssistantActionBlockCode; readonly message: string };

export interface AssistantSessionActions {
  readonly execution: AssistantExecutionState;
  readonly send: AssistantActionAvailability;
  /** 准备记录变更；提交结果待核对时仍允许只读交流。 */
  readonly prepare: AssistantActionAvailability;
  readonly confirm: AssistantActionAvailability;
  readonly discard: AssistantActionAvailability;
  readonly cancel: AssistantActionAvailability;
  readonly delete: AssistantActionAvailability;
  readonly edit: AssistantActionAvailability;
}

const ALLOWED: AssistantActionAvailability = { allowed: true };

/** 会话的业务状态与本页独占操作共同决定动作；该投影不进入持久化。 */
export function assistantSessionActions(
  session: AssistantSession,
  operation?: AssistantOperationPhase,
): AssistantSessionActions {
  let execution: AssistantExecutionState;
  if (operation === "saving-checkpoint" || operation === "waiting-for-lock") {
    execution = operation;
  } else if (operation === "finishing") {
    execution = "finishing-local";
  } else if (operation === "owned") {
    execution =
      session.status === "running"
        ? "running-local"
        : session.status === "committing"
          ? "committing-local"
          : "preparing-local";
  } else {
    execution =
      session.status === "running"
        ? "running-elsewhere"
        : session.status === "committing"
          ? "committing-elsewhere"
          : "idle";
  }
  const busy: AssistantActionAvailability =
    execution === "idle"
      ? ALLOWED
      : execution === "waiting-for-lock"
        ? {
            allowed: false,
            code: "waiting-for-lock",
            message: "正在等待其他标签页释放会话，可以停止等待",
          }
        : execution === "running-elsewhere"
          ? {
              allowed: false,
              code: "running-elsewhere",
              message: "会话正在其他标签页执行，请等待完成后重试",
            }
          : session.status === "committing"
            ? { allowed: false, code: "committing", message: "会话正在提交，完成后可继续操作" }
            : { allowed: false, code: "session-busy", message: "会话正在执行，请等待完成或停止" };
  const uncertain: AssistantActionAvailability = session.commitUncertain
    ? {
        allowed: false,
        code: "commit-uncertain",
        message: "上次提交结果待核对，可查询记录；放弃旧提案后再准备修改",
      }
    : ALLOWED;
  const preview: AssistantActionAvailability =
    !session.preview?.valid || !session.previewId
      ? { allowed: false, code: "preview-required", message: "提案已变化，请重新查看变更后确认" }
      : !session.proposal.operations.length
        ? { allowed: false, code: "empty-proposal", message: "提案为空" }
        : ALLOWED;
  const hasProposal = session.proposal.operations.length > 0 || session.commitUncertain;
  return {
    execution,
    send: busy,
    prepare: !busy.allowed ? busy : uncertain,
    confirm: !busy.allowed ? busy : !uncertain.allowed ? uncertain : preview,
    discard: !busy.allowed
      ? busy
      : hasProposal
        ? ALLOWED
        : { allowed: false, code: "empty-proposal", message: "没有可放弃的提案" },
    cancel:
      operation &&
      operation !== "finishing" &&
      !(operation === "owned" && session.status === "committing")
        ? ALLOWED
        : { allowed: false, code: "not-running", message: "当前没有可停止的本页请求" },
    delete:
      session.status === "committing"
        ? busy
        : session.status === "running" && operation !== "owned"
          ? {
              allowed: false,
              code: "running-elsewhere",
              message: "会话正在其他标签页执行，请等待完成后删除",
            }
          : ALLOWED,
    edit: busy,
  };
}

export class AssistantSessionActionError extends Error {
  readonly code: AssistantActionBlockCode;
  constructor(blocked: Extract<AssistantActionAvailability, { allowed: false }>) {
    super(blocked.message);
    this.name = "AssistantSessionActionError";
    this.code = blocked.code;
  }
}
