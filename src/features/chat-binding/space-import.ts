import { restoredMemoryMacros } from "../macros/macro-expression.ts";
import type { MemoryBackupRepository } from "../backup/index.ts";
import type { MemoryMacro } from "../macros/macro-expression.ts";
import { parseBackupFile, type MemorySpaceBackup } from "../backup/index.ts";
import type { SpaceContextStatus } from "./chat-space-manager.ts";
import { BINDING_UNRECOGNIZED_MESSAGE } from "./chat-space-manager.ts";
import { resolveImportAction, type ImportAction } from "./import-action.ts";

/**
 * 单空间/全库文件导入当前对话的编排（issue 26，从设置面板抽出）：
 *
 * - 解析与动作判定是纯逻辑（plan），面板只负责文件选择、确认弹窗与结果提示；
 * - 执行按动作分派：restore = 整体替换当前空间；clone-and-rebind / create-and-bind =
 *   克隆文件空间为新空间 + 重建/建立绑定（原空间保留，ADR 0012）；
 * - 执行成功后刷新面板数据、重建记忆宏快照、kick 镜像写回（与手动操作同一套联动）。
 *
 * 全库文件与单空间文件同构（都是 data.spaces[]），匹配只按当前绑定 spaceId 查找。
 */

/** 导入执行依赖（宿主 = runtime 服务；面板只传运行时端口） */
export interface SpaceImportExecutionDeps {
  readonly backup: Pick<MemoryBackupRepository, "restoreSpace">;
  readonly normalizeImportedSpace: (unit: MemorySpaceBackup) => Promise<MemorySpaceBackup>;
  readonly manager: Pick<SpaceImportManager, "importSpace" | "syncToCurrentChat">;
  /** 记忆宏快照重建（导入即整库数据变更，不等轮询） */
  readonly kickMacros: () => void;
  /** 对话文件镜像写回 kick */
  readonly kickMirror: () => void;
  /** 面板数据刷新（依赖数据的区块重取） */
  readonly onDataChanged: () => void;
  /**
   * 写回文件携带的对话级宏（spec 表格预设 6.3：单空间导出会带上导出时该对话的
   * 对话级宏，导入到当前对话时恢复）；文件缺省该键时不调用（保持当前对话的宏）。
   */
  readonly writeChatScopeMacros?: (macros: readonly MemoryMacro[]) => void | Promise<void>;
}

interface SpaceImportManager {
  importSpace(unit: MemorySpaceBackup): Promise<unknown>;
  syncToCurrentChat(): Promise<SpaceContextStatus | undefined>;
}

export type SpaceImportPlan =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      /** 文件名（用于结果提示） */
      readonly spaceName: string;
      readonly action: Exclude<ImportAction, { kind: "no-match" }>;
      /** 执行前确认文案（restore 与克隆两条路径的危险程度不同） */
      readonly confirmMessage: string;
    };

/**
 * 规划导入：解析校验文件（失败不触碰数据库）→ 按当前绑定判定动作 →
 * 生成确认文案。调用方负责在用户确认后调用 executeSpaceImport。
 */
export function planSpaceImport(
  text: string,
  status: SpaceContextStatus | undefined,
): SpaceImportPlan {
  let decoded;
  try {
    decoded = parseBackupFile(text);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  // binding-unrecognized 绝不能当作无绑定去新建覆盖，故报错；其余视作无绑定。
  if (status?.kind === "binding-unrecognized") {
    return { kind: "error", message: BINDING_UNRECOGNIZED_MESSAGE };
  }
  // active / branch-detected / space-missing 都持有有效绑定；space-missing 时若文件
  // 含该 spaceId 则 restore 直接恢复（符合「空间缺失从备份恢复」），不覆盖绑定。
  const currentBinding =
    status?.kind === "active" ||
    status?.kind === "branch-detected" ||
    status?.kind === "space-missing"
      ? status.binding
      : null;
  const action = resolveImportAction(decoded, currentBinding);
  if (action.kind === "no-match") {
    return { kind: "error", message: "文件中不包含当前记忆空间的数据" };
  }
  return {
    kind: "ready",
    spaceName: action.unit.space.name,
    action,
    confirmMessage:
      action.kind === "restore"
        ? `将用文件中的数据替换当前记忆空间「${action.unit.space.name}」的全部记录。此操作不可撤销。确认？`
        : "将创建新的记忆空间并绑定到当前对话，原空间数据保留。确认？",
  };
}

/** 执行导入（调用方已确认）：按动作分派 + 成功后触发面板/宏/镜像联动。 */
export async function executeSpaceImport(
  plan: Extract<SpaceImportPlan, { kind: "ready" }>,
  deps: SpaceImportExecutionDeps,
): Promise<void> {
  const normalized = await deps.normalizeImportedSpace(plan.action.unit);
  const unit: MemorySpaceBackup = {
    ...normalized,
    space: { ...normalized.space, macros: restoredMemoryMacros(normalized.space.macros ?? []) },
    ...(normalized.chatScopeMacros === undefined
      ? {}
      : { chatScopeMacros: restoredMemoryMacros(normalized.chatScopeMacros) }),
  };
  if (plan.action.kind === "restore") {
    await deps.backup.restoreSpace(unit);
    // 绑定不变、空间仍在：重同步收敛
    await deps.manager.syncToCurrentChat();
  } else {
    // clone-and-rebind / create-and-bind 共用：克隆新空间 + 重建/建立绑定
    await deps.manager.importSpace(unit);
  }
  // 文件携带对话级宏时写回当前对话（缺省 = 保持当前对话的宏）
  if (unit.chatScopeMacros !== undefined) {
    await deps.writeChatScopeMacros?.(unit.chatScopeMacros);
  }
  deps.onDataChanged();
  deps.kickMacros();
  deps.kickMirror();
}
