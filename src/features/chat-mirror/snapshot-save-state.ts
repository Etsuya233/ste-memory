export type SnapshotSaveOperation = "update" | "replacement" | "force-sync";
export type SnapshotSaveFailurePhase = "submit" | "verify" | "confirm";

export type SnapshotCleanupStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly operationIds: readonly number[] }
  | {
      readonly kind: "failed";
      readonly operationIds: readonly number[];
      readonly message: string;
    };

interface SnapshotOperationIdentity {
  readonly identity: string;
  readonly operationId: number;
  readonly operation: SnapshotSaveOperation;
}

export type ChatSnapshotSaveStatus = (
  | { readonly kind: "idle" }
  | (SnapshotOperationIdentity & {
      readonly kind: "queued" | "saving" | "verifying" | "confirming";
    })
  | (SnapshotOperationIdentity & {
      readonly kind: "submitted" | "verified";
      readonly completedAt: string;
      readonly sizeBytes: number;
    })
  | (SnapshotOperationIdentity & {
      readonly kind: "failed";
      readonly phase: SnapshotSaveFailurePhase;
      readonly error: string;
      readonly humanMsg: string;
    })
) & { readonly cleanup: SnapshotCleanupStatus };

export interface SnapshotSaveActions {
  readonly busy: boolean;
  readonly recovery: "retry-save" | "retry-cleanup" | null;
  readonly canRetry: boolean;
  readonly canForceSync: boolean;
  readonly disabledReason: string | null;
}

/** Presentation and commands share the same recovery policy; cleanup never changes durability. */
export function snapshotSaveActions(
  status: ChatSnapshotSaveStatus,
  available: boolean,
): SnapshotSaveActions {
  const busy =
    status.kind === "queued" ||
    status.kind === "saving" ||
    status.kind === "verifying" ||
    status.kind === "confirming" ||
    status.cleanup.kind === "running";
  const recovery =
    status.kind === "failed"
      ? "retry-save"
      : status.cleanup.kind === "failed"
        ? "retry-cleanup"
        : null;
  const disabledReason = !available
    ? "请回到原对话后操作"
    : busy
      ? "操作正在进行，请等待完成"
      : null;
  return {
    busy,
    recovery,
    canRetry: recovery !== null && disabledReason === null,
    canForceSync: disabledReason === null,
    disabledReason,
  };
}
