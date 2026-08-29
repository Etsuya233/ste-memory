import type { MemoryBackupFile, MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { ChatSpaceBinding } from "./chat-space-manager.ts";

/**
 * 单空间导入动作解析器（issue 26 新 seam，纯函数）：
 * 给定已解码校验的备份文件 + 当前对话绑定，判断下一步该执行哪条导入路径。
 *
 * 判别联合四种结果：
 * - restore：文件中存在与当前 spaceId 一致的单元 → 整体替换当前空间（restoreSpace）。
 * - clone-and-rebind：绑定存在但无 id 匹配，且文件为单空间单元 → cloneSpace 创建新空间
 *   + 重建绑定（原空间保留，ADR 0012）。
 * - create-and-bind：无绑定，且文件为单空间单元 → cloneSpace 创建新空间 + 建立新绑定。
 * - no-match：文件中找不到可导入到当前对话的单元（多空间文件无法自动挑选 / 空文件）→ 报错。
 *
 * 全库文件兼容：单空间与全库文件同构（都是 data.spaces[]），匹配只按当前 spaceId find；
 * 单空间文件 vs 多空间文件的区分决定了「不匹配时克隆」还是「无匹配时报错」——
 * 多空间文件无 id 匹配时无法安全决定克隆哪一个，故报错（除非有 id 匹配 → restore）。
 */
export type ImportAction =
  | { readonly kind: "restore"; readonly unit: MemorySpaceBackup }
  | {
      readonly kind: "clone-and-rebind";
      readonly unit: MemorySpaceBackup;
      readonly currentSpaceId: ChatSpaceBinding["spaceId"];
    }
  | { readonly kind: "create-and-bind"; readonly unit: MemorySpaceBackup }
  | { readonly kind: "no-match"; readonly availableSpaceIds: readonly ChatSpaceBinding["spaceId"][] };

/**
 * 解析单空间导入动作。
 *
 * @param file 已通过 decodeBackupFile/parseBackupFile 校验的备份文件
 * @param currentBinding 当前对话绑定；无绑定（none / unrecognized）传 null
 */
export function resolveImportAction(
  file: MemoryBackupFile,
  currentBinding: ChatSpaceBinding | null,
): ImportAction {
  const spaces = file.data.spaces;
  const availableSpaceIds = spaces.map((unit) => unit.space.id);

  if (currentBinding === null) {
    // 无绑定：只能凭文件创建新空间绑定；多空间文件无法决定绑定哪一个 → 报错
    if (spaces.length === 1) {
      return { kind: "create-and-bind", unit: spaces[0]! };
    }
    return { kind: "no-match", availableSpaceIds };
  }

  const currentSpaceId = currentBinding.spaceId;
  const matched = spaces.find((unit) => unit.space.id === currentSpaceId);
  if (matched) {
    return { kind: "restore", unit: matched };
  }

  // 绑定存在但无 id 匹配：单空间文件（来自别的对话）克隆为新空间并重建绑定；
  // 多空间文件无法决定克隆哪一个 → 报错（用户应改导全库或对应单空间文件）
  if (spaces.length === 1) {
    return { kind: "clone-and-rebind", unit: spaces[0]!, currentSpaceId };
  }
  return { kind: "no-match", availableSpaceIds };
}
