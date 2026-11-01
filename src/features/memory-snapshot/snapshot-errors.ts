import { DomainError } from "../memory/index.ts";

export function snapshotInvalid(reason: string, label = "记忆快照"): never {
  throw new DomainError({
    type: "memory_backup_format_invalid",
    param: { reason },
    humanMsg: `${label}无效：${reason}`,
  });
}
