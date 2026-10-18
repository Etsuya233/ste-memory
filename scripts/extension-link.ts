import { lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * ST 扩展目录的「链接直连」seam（开发用）：把扩展目录做成指向 dist/ 的目录链接
 * （Windows Junction 不需要管理员；POSIX symlink），ST 直接读取构建产物，
 * `pnpm watch` 不再需要拷贝。TS 源码不能直接链接——ST 只加载构建产物
 * （index.js / manifest.json / style.css），链接目标必须是 dist/。
 *
 * 安全边界：目标已存在真实目录（或指向别处的链接）一律拒绝，绝不删用户数据；
 * 移除只删链接本身，dist 内容不受影响（Windows 下 rmSync 对 junction 只解链接）。
 */

/** lstat 探测（含断链：指向已消失目标的链接也算存在） */
function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** 目标目录是否为「指向 dist 的链接」（Junction / symlink）；真目录一律 false。 */
export function isLinkToDist(distDir: string, targetDir: string): boolean {
  if (!pathExists(distDir) || !pathExists(targetDir)) return false;
  try {
    if (!lstatSync(targetDir).isSymbolicLink()) return false;
    return realpathSync(targetDir) === realpathSync(distDir);
  } catch {
    return false;
  }
}

/** 建链动作（planExtensionLink 产物）：create / 已是链接 / 拒绝并给出原因 */
export type ExtensionLinkPlan =
  | { readonly kind: "create" }
  | { readonly kind: "already-linked" }
  | { readonly kind: "blocked"; readonly reason: string };

/** 目标目录当前状态 → 建链动作（纯函数，st:link CLI 与测试共用）。 */
export function planExtensionLink(distDir: string, targetDir: string): ExtensionLinkPlan {
  if (!pathExists(targetDir)) return { kind: "create" };
  if (isLinkToDist(distDir, targetDir)) return { kind: "already-linked" };
  if (lstatSync(targetDir).isSymbolicLink()) {
    return {
      kind: "blocked",
      reason: `已存在指向其他位置的链接（${realpathSync(targetDir)}）；先 pnpm st:unlink 或手动删除`,
    };
  }
  return {
    kind: "blocked",
    reason: "已存在真实目录（未做任何改动）；请先改名/移走它，或改用拷贝流程（pnpm sync）",
  };
}

export interface CreateExtensionLinkResult {
  readonly status: "created" | "already-linked";
}

/** 建立链接（父目录自动创建）；已是指向 dist 的链接则幂等返回。 */
export function createExtensionLink(distDir: string, targetDir: string): CreateExtensionLinkResult {
  const plan = planExtensionLink(distDir, targetDir);
  if (plan.kind === "blocked") {
    throw new Error(`无法建立链接：${plan.reason}`);
  }
  if (plan.kind === "already-linked") return { status: "already-linked" };
  mkdirSync(path.dirname(targetDir), { recursive: true });
  // Windows 用 junction（免管理员）；其余平台用目录 symlink
  symlinkSync(distDir, targetDir, process.platform === "win32" ? "junction" : "dir");
  return { status: "created" };
}

export interface RemoveExtensionLinkResult {
  readonly status: "removed" | "absent";
}

/** 移除链接（只删链接本身）；目标不是链接时拒绝，绝不递归删真实目录。 */
export function removeExtensionLink(targetDir: string): RemoveExtensionLinkResult {
  if (!pathExists(targetDir)) return { status: "absent" };
  if (!lstatSync(targetDir).isSymbolicLink()) {
    throw new Error(`目标不是链接（未做任何改动）：${targetDir}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  return { status: "removed" };
}
