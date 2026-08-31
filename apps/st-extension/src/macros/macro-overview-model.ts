/**
 * 宏内容一览 model（issue 01）：把两个宏服务的预计算快照聚合为展示行列表
 * （宏名 + 展开文本实际值）。纯函数，数据源 = 宏服务快照（与宏 handler 返回
 * 同源）；宿主（runtime）在 panel-shell 组装输入，组件只做展示接线。
 *
 * 行序：记忆宏家族（默认快照 {{前缀}} → 全局视图 → 聊天 Scope 宏 → 内置宏
 * full/表 Key）→ Agent 预设宏（{{tablesDigest}}/{{systemDefaultPrompt}}）。
 * 全局前缀为空/不合法（宏未注册）时记忆宏家族整体不列（无宏可展开），
 * Agent 预设宏与前缀无关、始终列出。
 */

/** 宏内容一览的一行：宏名（花括号形态）+ 展开文本（快照实际值） */
export interface MacroOverviewRow {
  /** 宏名（花括号形态，如 {{ste}} / {{ste::角色}}） */
  readonly name: string;
  /** 展开文本（预计算快照实际值；空 = 无可展开内容，展示「（空）」） */
  readonly text: string;
}

/** 聚合输入：宿主从记忆宏服务 + Agent 预设宏服务读取（panel-shell 组装） */
export interface MacroOverviewInput {
  /** 记忆宏全局前缀（裸标识符，如 ste；空 = 宏未注册，记忆宏家族不列） */
  readonly prefix: string;
  /** 默认快照（{{前缀}} 无参展开） */
  readonly defaultSnapshot: string;
  /** 全局视图快照（视图名 → 文本，按视图配置顺序） */
  readonly views: readonly { readonly name: string; readonly text: string }[];
  /** 聊天 Scope 宏快照（宏名 → 文本，按定义顺序） */
  readonly chatScopeMacros: readonly { readonly name: string; readonly text: string }[];
  /** 内置宏快照（名字 = full / 表 Key；full 应在前） */
  readonly builtin: readonly { readonly name: string; readonly text: string }[];
  /** Agent 预设宏行（host 已按话形式包装：{{tablesDigest}}/{{systemDefaultPrompt}}） */
  readonly agent: readonly { readonly name: string; readonly text: string }[];
}

/** 把两服务的预计算快照聚合为展示行（纯函数，可单测） */
export function buildMacroOverviewRows(input: MacroOverviewInput): readonly MacroOverviewRow[] {
  const rows: MacroOverviewRow[] = [];
  if (input.prefix !== "") {
    rows.push({ name: macroName(input.prefix), text: input.defaultSnapshot });
    for (const view of input.views) {
      rows.push({ name: macroName(`${input.prefix}::${view.name}`), text: view.text });
    }
    for (const macro of input.chatScopeMacros) {
      rows.push({ name: macroName(`${input.prefix}::${macro.name}`), text: macro.text });
    }
    for (const builtin of input.builtin) {
      rows.push({ name: macroName(`${input.prefix}::${builtin.name}`), text: builtin.text });
    }
  }
  rows.push(...input.agent);
  return rows;
}

/** 裸标识符 → 花括号宏名（{{ste}}） */
function macroName(name: string): string {
  return `{{${name}}}`;
}
