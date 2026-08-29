#!/usr/bin/env node
// 发布 STE Memory 到 SillyTavern：把 st-extension 的构建产物重生成到 release/sillytavern-plugin 分支。
//
// 模型：release 分支是【生成产物】，不是同步分支——每次发版都从 main 的当前 commit 重新生成，
// 从不 merge/cherry-pick 进该分支。ST 通过 `git clone --branch <分支>` 安装插件，
// 分支根目录必须存在 manifest.json 才能安装成功（SillyTavern 的 /api/extensions/install）。
//
// 用法：
//   node scripts/release-st.mjs            # 构建 → 重生成 release 分支 → commit → push
//   node scripts/release-st.mjs --dry-run  # 只构建 + 暂存，不 commit / 不 push
//
// 发版流程：
//   1. 在 main 上把 apps/st-extension/package.json 与 manifest.json 的 version 更新为新版本号
//   2. 合并/推送代码到 main
//   3. 运行本脚本（版本号取 package.json，回写进产物 manifest.json，保证同源）
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BRANCH = "release/sillytavern-plugin";
const WORKTREE_DIR = path.join(REPO_ROOT, ".worktrees", "release", "sillytavern-plugin");
const ST_PKG = path.join(REPO_ROOT, "apps", "st-extension", "package.json");
const ST_DIST = path.join(REPO_ROOT, "apps", "st-extension", "dist");
const DIST_FILES = ["index.js", "manifest.json", "style.css"];
const REMOTE = "origin";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function log(step, message) {
  console.log(`\n== ${step} ==\n${message}`);
}

function die(message) {
  console.error(`[release-st] 失败：${message}`);
  process.exit(1);
}

/**
 * 把 release 分支检出/创建到 worktree 目录。
 * 规则（remote 是唯一真相，本地分支只是它的镜像）：
 *  - remote 分支存在 → 硬对齐到 origin/<分支>
 *  - 仅本地分支存在（首次从未 push）→ 检出它
 *  - 都不存在 → 以 orphan 分支起步（release 历史只含发版 commit，不含 monorepo 历史）
 */
function ensureReleaseWorktree() {
  const remoteBranch = git(["ls-remote", "--heads", REMOTE, RELEASE_BRANCH]);
  const localBranch = git(["branch", "--list", RELEASE_BRANCH]);
  const worktreeExists = existsSync(path.join(WORKTREE_DIR, ".git"));

  git(["fetch", REMOTE]);

  if (worktreeExists) {
    if (remoteBranch) {
      git(["checkout", "-B", RELEASE_BRANCH, `${REMOTE}/${RELEASE_BRANCH}`], WORKTREE_DIR);
    } else if (localBranch) {
      git(["checkout", RELEASE_BRANCH], WORKTREE_DIR);
    } else {
      git(["switch", "--orphan", RELEASE_BRANCH], WORKTREE_DIR);
    }
    return;
  }

  if (remoteBranch) {
    git(["worktree", "add", "-B", RELEASE_BRANCH, WORKTREE_DIR, `${REMOTE}/${RELEASE_BRANCH}`]);
  } else if (localBranch) {
    git(["worktree", "add", WORKTREE_DIR, RELEASE_BRANCH]);
  } else {
    git(["worktree", "add", "--detach", WORKTREE_DIR]);
    git(["switch", "--orphan", RELEASE_BRANCH], WORKTREE_DIR);
  }
}

/** 清空 worktree 内容（保留 .git），内容完全由本次构建重生成 */
function clearWorktree() {
  for (const entry of readdirSync(WORKTREE_DIR)) {
    if (entry === ".git") continue;
    rmSync(path.join(WORKTREE_DIR, entry), { recursive: true, force: true });
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 产物 manifest 的 version 回写为 package.json 的版本（构建注入 __STE_MEMORY_VERSION__ 同源） */
function stampManifestVersion(manifestPath, version) {
  const manifest = readJson(manifestPath);
  if (manifest.version !== version) {
    console.log(`  manifest version ${manifest.version} → ${version}（与 package.json 对齐）`);
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/** 生成 release 分支的 README：安装方式 + 本次发版来源信息 */
function writeReleaseReadme(version, sourceBranch, sourceCommit, sourceCommitShort) {
  const readme = `# STE Memory — SillyTavern 插件发布分支

本分支是**构建产物**，由 \`scripts/release-st.mjs\` 从主仓库重生成，请勿直接修改或提交 PR。
源代码与 issue 追踪：<https://github.com/Etsuya233/ste-memory>

## 安装（SillyTavern）

扩展 → Install extension：

- **URL**：\`https://github.com/Etsuya233/ste-memory\`
- **Branch or tag name**：\`${RELEASE_BRANCH}\`
- 安装时勾选“Install for all users”（可选，仅管理员）

更新：扩展面板点 **Update**（本分支 push 新 commit 后即可见）；
或把 manifest.json 的 "auto_update" 字段改为 true 开启每日自动更新检查。

## 当前版本

- 版本：${version}
- 源提交：${sourceCommitShort}（${sourceBranch}）
- 构建时间：${new Date().toISOString()}

## 卸载

扩展面板中把 **STE Memory** 设为禁用，或直接删除
\`public/scripts/extensions/third-party/ste-memory\` 目录后刷新页面。
`;
  writeFileSync(path.join(WORKTREE_DIR, "README.md"), readme);
}

// ---------- 1. 预检 ----------
log("预检", `仓库：${REPO_ROOT}\n目标分支：${RELEASE_BRANCH}${dryRun ? "（--dry-run，不 commit / 不 push）" : ""}`);

const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
if (dirty) {
  die(`main 工作区有未提交的改动，请先提交或 stash：\n${dirty}`);
}
if (!existsSync(ST_PKG)) {
  die(`找不到 ${ST_PKG}`);
}

const version = readJson(ST_PKG).version;
if (!version) {
  die("apps/st-extension/package.json 缺少 version 字段");
}
const sourceBranch = git(["branch", "--show-current"]);
const sourceCommit = git(["rev-parse", "HEAD"]);
const sourceCommitShort = sourceCommit.slice(0, 7);
log("版本", `v${version}（源：${sourceBranch} @ ${sourceCommitShort}）`);

// ---------- 2. 构建（产物到 apps/st-extension/dist） ----------
log("构建", "pnpm --filter @ste-memory/st-extension build");
execFileSync("pnpm", ["--filter", "@ste-memory/st-extension", "build"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

for (const file of DIST_FILES) {
  if (!existsSync(path.join(ST_DIST, file))) {
    die(`构建产物缺失：${path.join(ST_DIST, file)}`);
  }
}
stampManifestVersion(path.join(ST_DIST, "manifest.json"), version);

// ---------- 3. 重生成 release 分支（worktree） ----------
log("release 分支", WORKTREE_DIR);
ensureReleaseWorktree();
clearWorktree();

// 产物平铺到分支根目录（manifest 的 js/css 字段指向根目录文件，ST 按仓库名 + 分支安装）
for (const file of DIST_FILES) {
  copyFileSync(path.join(ST_DIST, file), path.join(WORKTREE_DIR, file));
}
writeReleaseReadme(version, sourceBranch, sourceCommit, sourceCommitShort);

git(["add", "-A"], WORKTREE_DIR);

const staged = git(["status", "--porcelain"], WORKTREE_DIR);
if (!staged) {
  log("无变更", "release 分支内容与上次发版一致，跳过 commit");
} else {
  log("变更", staged);
  if (dryRun) {
    console.log("[dry-run] 跳过 commit 与 push");
  } else {
    git(["commit", "-m", `release v${version}（源提交 ${sourceCommitShort} @ ${sourceBranch}）`], WORKTREE_DIR);
    git(["push", REMOTE, RELEASE_BRANCH], WORKTREE_DIR);
  }
}

// ---------- 4. 结果 ----------
if (dryRun) {
  console.log("\n[dry-run] 验证通过。正式发版去掉 --dry-run 重跑即可。");
} else {
  console.log(`
发布完成 ✓  v${version} → ${RELEASE_BRANCH}

用户安装方式（SillyTavern）：
  URL: https://github.com/Etsuya233/ste-memory
  Branch or tag name: ${RELEASE_BRANCH}

下次发版：先在 main 更新 version（apps/st-extension/package.json + manifest.json），
再重跑本脚本。`);
}