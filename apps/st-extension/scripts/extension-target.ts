import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ST 扩展目标目录：`<ST 安装根>/public/scripts/extensions/third-party/ste-memory`
 * （ST 按目录发现扩展：global 在 public/scripts/extensions/third-party/<name>/）
 */
export const ST_EXTENSION_SUBPATH = path.join(
  "public",
  "scripts",
  "extensions",
  "third-party",
  "ste-memory",
);

export interface ExtensionTargetEnv {
  /** 直接指向扩展目标目录（优先） */
  STE_ST_EXTENSION_DIR?: string;
  /** SillyTavern 安装根目录（自动推导 ST_EXTENSION_SUBPATH） */
  STE_ST_INSTALL?: string;
}

export function resolveExtensionTarget(env: ExtensionTargetEnv): string {
  const direct = env.STE_ST_EXTENSION_DIR?.trim();
  if (direct) {
    return path.resolve(direct);
  }
  const install = env.STE_ST_INSTALL?.trim();
  if (install) {
    return path.join(path.resolve(install), ST_EXTENSION_SUBPATH);
  }
  throw new Error(
    "未配置 ST 扩展目录：请在 apps/st-extension/.env 设置 STE_ST_EXTENSION_DIR（直接指向 " +
      "extensions/third-party/ste-memory 目录）或 STE_ST_INSTALL（SillyTavern 安装根目录），参考 .env.example。",
  );
}

export interface CopyResult {
  copied: string[];
}

/** 把 dist 目录下所有文件拷贝进目标目录（递归创建），返回落盘的文件路径 */
export function copyDistToTarget(distDir: string, targetDir: string): CopyResult {
  if (!existsSync(distDir)) {
    throw new Error(`dist 目录不存在：${distDir}（请先运行 build）`);
  }
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(distDir)) {
    const source = path.join(distDir, entry);
    if (!statSync(source).isFile()) {
      continue;
    }
    const dest = path.join(targetDir, entry);
    copyFileSync(source, dest);
    copied.push(dest);
  }
  return { copied };
}
