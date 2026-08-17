import type {
  ChatBindingStore,
  ChatBindingStoreRead,
  ChatSnapshot,
  ChatSpaceBinding,
} from "../space-binding/chat-space-manager.ts";
import type { ChatMirrorStore } from "../chat-mirror/chat-metadata-mirror-sync.ts";
import type { MemoryMacroRegistrationPort } from "../macros/memory-macro-service.ts";
import type { AgentPromptNames, AgentPromptSnapshot } from "../agent-presets/preset-composer.ts";
import type { ChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import {
  formatCleaningListSelection,
  parseCleaningListSelection,
  type CleaningListStore,
} from "../settings/cleaning-rule-lists.ts";
import { resolveFloorJump } from "./floor-jump.ts";
/**
 * ST 1.18 getContext() 返回对象的插件所需子集（public/scripts/st-context.js 已核实）。
 * 事件 payload 事实（public/script.js 已核实）：CHAT_CHANGED 带当前 chatId、
 * MESSAGE_SENT 带消息下标、MESSAGE_RECEIVED 带（下标, 类型）——本适配器不消费
 * payload，一律重读快照/忽略，隔离 ST 内部变更。
 */
export interface StContext {
  /** 当前对话文件名（无 .jsonl）；临时/未保存对话为 undefined */
  chatId?: string;
  /** 当前角色索引；群聊为 undefined */
  characterId?: number | string | undefined;
  /** 当前群聊 id（selected_group）；非群聊为 null */
  groupId?: string | number | null;
  /** 角色名（name2）；群聊为 undefined */
  name2?: string;
  /** 当前用户显示名（name1；Agent 预设 {{user}} 占位符展开用） */
  name1?: string;
  /** 群聊列表（{{char}} 群聊展开为群名时经 id 查找群名；{{char_card}} 经 members 取群成员卡） */
  groups?: readonly {
    id: string | number;
    name?: string;
    members?: readonly (string | number)[];
  }[];
  /** 当前对话消息数组（同步楼层 = 数组下标，ADR 0003） */
  chat?: readonly unknown[];
  /**
   * ST 当前用户 Persona 描述（power_user.persona_description，personas.js 已核实：
   * 随当前 persona 切换/编辑同步更新）——{{user_card}} 占位符展开用。
   */
  powerUserSettings?: { readonly persona_description?: string };
  /**
   * 当前角色卡数组（st-context.js 暴露 characters：角色卡 description 读取源，
   * {{char_card}} 占位符展开用；characterId 即 this_chid 数组下标）。
   */
  characters?: readonly {
    readonly id?: string | number;
    readonly name?: string;
    readonly description?: string;
  }[];
  /** 当前上下文大小（token；ST getContext().maxContext = Number(max_context)） */
  maxContext?: number;
  /**
   * ST 世界书扫描（getContext().getWorldInfoPrompt，release 1.18.0 已核实）：
   * 把剧情文本包成单条消息委托 ST 匹配（ADR 0007）；旧版 ST 无此函数 → 插件降级空串。
   */
  getWorldInfoPrompt?: (
    chat: readonly unknown[],
    maxContext: number,
    isDryRun: boolean,
  ) => Promise<{ readonly worldInfoString: string }>;
  /** 随对话文件持久化的元数据对象（saveChat 全量重写聊天文件时携带，重命名自动跟随） */
  chatMetadata?: Record<string, unknown>;
  /** 防抖持久化 chatMetadata（script.js saveMetadataDebounced） */
  saveMetadataDebounced?: () => void;
  /**
   * ST 全局扩展设置对象（extensions.js extension_settings，随 settings.json
   * 持久化）。插件设置写在该对象的 steMemory 命名空间下（见 settings/）。
   */
  extensionSettings?: Record<string, unknown>;
  /** ST 当前对话生成配置（openai.js oai_settings，st-context.js chatCompletionSettings）——
   * LLM 适配器（ticket 12）据此复用 ST 当前模型/密钥（密钥在服务端，插件永不见 key） */
  chatCompletionSettings?: Record<string, unknown>;
  /** ST getChatCompletionModel(settings)：按当前 source 返回模型名（st-context.js 暴露，
   * 映射表集中在 ST 侧，插件不复制 26 个 source 的模型字段映射） */
  getChatCompletionModel?: (settings: Record<string, unknown>) => string;
  /** 防抖持久化 extension_settings（script.js saveSettingsDebounced） */
  saveSettingsDebounced?: () => void;
  /** 当前预设管理器（st-context.js 暴露 getPresetManager：正则预设条目读取源，
   * readPresetExtensionField 读当前预设的扩展字段） */
  getPresetManager?: () =>
    | {
        readonly readPresetExtensionField?: (input: { readonly path: string }) => unknown;
      }
    | undefined;
  eventSource?: {
    readonly on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  eventTypes?: {
    readonly CHAT_CHANGED: string;
    readonly MESSAGE_SENT: string;
    readonly MESSAGE_RECEIVED: string;
  };
  /**
   * ST 新宏引擎（public/scripts/macros/macro-system.js 已核实，release 1.18.0）：
   * register(name, { handler, description, ... }) 的 name 是裸标识符（不含花括号），
   * 查找大小写不敏感；同名注册覆盖并警告；handler 严格同步（Promise 会被字符串化）；
   * registry.unregisterMacro(name) 注销。记忆宏（ticket 15 / ADR 0004）经此注册。
   */
  macros?: {
    readonly register: (
      name: string,
      options: { readonly handler: (context: unknown) => string },
    ) => unknown;
    readonly registry?: {
      readonly unregisterMacro: (name: string) => boolean;
    };
  };
}

/**
 * 记忆空间绑定在 chatMetadata 里的键（ADR 0002 小指针，随对话文件走）。
 * 与 ST 既有 metadata 键（system_prompt / scenario / worldinfo / quickReply 等）
 * 无冲突；命名空间化的值对象 { version, spaceId } 便于未来演进。
 */
/** ST 正则条目来源（ticket 22 / ADR 0011）：全局 / 当前角色卡 / 当前预设 / 导入文件 */
export type StRegexEntrySource = "global" | "scoped" | "preset" | "file";

/** 一条 ST 正则条目及其来源（导入对话框按来源标注）。 */
export interface StRegexEntry {
  readonly source: StRegexEntrySource;
  readonly script: unknown;
}

export const CHAT_METADATA_BINDING_KEY = "steMemory";
/** 记忆镜像在 chatMetadata 里的键（ticket 16 / ADR 0023）：独立键，不动绑定键——
 * 旧版本插件忽略新键（降级安全），绑定读取路径（三态 + unrecognized 防御）零改动。 */
export const CHAT_METADATA_MIRROR_KEY = "steMemoryMirror";
/** 清洗规则列表选择在 chatMetadata 里的键（ticket 22 / ADR 0011）：独立键，
 * 随对话文件走（重命名不丢），旧版本插件忽略新键（镜像键同款降级安全）。 */
export const CHAT_METADATA_CLEANING_LIST_KEY = "steMemoryCleaningList";

/** ST 事件桥（ticket 05）：CHAT_CHANGED 切换空间上下文；消息事件仅注册为未来触发点 */
export interface StEventBridge {
  /** CHAT_CHANGED：切换对话 → 重新同步空间上下文 */
  onChatChanged(): void | Promise<void>;
  /** MESSAGE_SENT / MESSAGE_RECEIVED：未来自动填表的触发点（ticket 13），当前无消费方 */
  onMessageEvent(kind: "message_sent" | "message_received"): void;
}

export type FloorJumpResult =
  | { readonly kind: "jumped" }
  | { readonly kind: "out-of-range"; readonly chatLength: number }
  | { readonly kind: "not-loaded" };

/** 按同步楼层读出的 ST 消息子集（证据 chip 悬停/长按摘录用；ST DOM 不测，薄层映射） */
export interface StChatMessage {
  /** 同步楼层（= 消息数组下标，ADR 0003） */
  readonly floor: number;
  /** 消息正文（ST mes 字段，含格式化标记的原文） */
  readonly content: string;
  /** 发送者名（角色名 / 用户侧显示名；缺失为空串） */
  readonly name: string;
  /** 是否用户消息（ST is_user） */
  readonly isUser: boolean;
}

/**
 * ST 环境适配器：把 ST getContext() 包装成插件逻辑层（ChatSpaceManager）
 * 可用的端口（快照 / 绑定读写 / 事件桥 / 楼层跳转）。这是宿主侧薄层——
 * 逻辑判定在纯模块（floor-jump / chat-space-manager），此处只做字段映射与 DOM。
 *
 * 注意：ST 的 getContext() 每次调用都构造新对象（script.js 模块变量为活引用，
 * 切对话时 chat_metadata 会被整体替换），因此适配器持有 getContext 工厂而非
 * 一次性快照——每次读写都重取，保证 chatId / chatMetadata 是最新对话的。
 */
export class StChatAdapter {
  readonly #getContext: () => StContext;

  constructor(getContext: () => StContext) {
    this.#getContext = getContext;
  }

  /** 当前对话快照（空串 chatId 按未保存处理） */
  getChatSnapshot(): ChatSnapshot {
    const context = this.#getContext();
    return {
      chatId: context.chatId || undefined,
      characterId: context.characterId,
      groupId: context.groupId ?? null,
      characterName: context.name2,
    };
  }

  /**
   * Agent 提示词预设占位符展开用名字（ticket 17）：任务提交时快照一次。
   * 单角色 char = name2；群聊 char = 群名（用户决策，与 ST 内建 {{char}} 的
   * 「群聊 = 当前角色名」语义不同）；查不到群名/缺名字 = 空串。
   */
  getPromptNames(): AgentPromptNames {
    const context = this.#getContext();
    const inGroup = context.groupId != null && context.groupId !== "";
    const groupName = inGroup
      ? (context.groups ?? []).find((g) => g.id === context.groupId)?.name
      : undefined;
    return {
      user: context.name1 ?? "",
      char: inGroup ? (groupName ?? "") : (context.name2 ?? ""),
    };
  }

  /**
   * Agent 提示词预设占位符展开用卡片文本（消息编排扩展）：任务提交时快照一次。
   * charCard = 当前角色卡 description（单角色）；群聊 = 群成员角色卡
   * 「名字：描述」逐条拼接（{{char}} 群聊 = 群名，成员名字靠这里补）；
   * userCard = 当前 Persona 描述（powerUserSettings.persona_description，
   * ST 随 persona 切换同步）。查不到/缺字段 = 空串（不留占位符原文）。
   */
  getPromptSnapshot(): AgentPromptSnapshot {
    const context = this.#getContext();
    const characters = context.characters ?? [];
    const inGroup = context.groupId != null && context.groupId !== "";
    const group = inGroup
      ? (context.groups ?? []).find((g) => g.id === context.groupId)
      : undefined;
    let charCard = "";
    if (inGroup && group) {
      const lines: string[] = [];
      for (const memberId of group.members ?? []) {
        const card = characters.find((c) => c.id === memberId);
        const description = card?.description?.trim() ?? "";
        if (description === "") continue;
        lines.push(`${card?.name ?? ""}：${description}`);
      }
      charCard = lines.join("\n\n");
    } else if (context.characterId != null && !inGroup) {
      const card = characters.find((c) => c.id === context.characterId);
      charCard = card?.description?.trim() ?? "";
    }
    return {
      names: this.getPromptNames(),
      charCard,
      userCard: context.powerUserSettings?.persona_description?.trim() ?? "",
      worldbookText: "",
      msgText: "",
    };
  }

  /** chatMetadata 绑定读写端口：写入即触发防抖持久化（随聊天文件走） */
  get bindingStore(): ChatBindingStore {
    return {
      read: () => readChatSpaceBinding(this.#getContext().chatMetadata),
      write: (binding) => {
        const context = this.#getContext();
        const metadata = context.chatMetadata;
        if (!metadata) return;
        // 写全新对象，不 alias 调用方传入的引用
        metadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: binding.spaceId };
        context.saveMetadataDebounced?.();
      },
    };
  }

  /** chatMetadata 镜像读写端口（ticket 16）：写即触发防抖持久化（随聊天文件走） */
  get mirrorStore(): ChatMirrorStore {
    return {
      read: () => this.#getContext().chatMetadata?.[CHAT_METADATA_MIRROR_KEY],
      write: (file: ChatMirrorFile) => {
        const context = this.#getContext();
        const metadata = context.chatMetadata;
        if (!metadata) return;
        metadata[CHAT_METADATA_MIRROR_KEY] = file;
        context.saveMetadataDebounced?.();
      },
    };
  }

  /**
   * chatMetadata 清洗列表选择读写端口（ticket 22 / ADR 0011）：独立键小指针
   * {version:1, listId}；写入 undefined = 清除选择（删除键）。随对话文件走。
   */
  get cleaningListStore(): CleaningListStore {
    return {
      read: () =>
        parseCleaningListSelection(
          this.#getContext().chatMetadata?.[CHAT_METADATA_CLEANING_LIST_KEY],
        ),
      write: (listId) => {
        const context = this.#getContext();
        const metadata = context.chatMetadata;
        if (!metadata) return;
        if (listId === undefined) {
          delete metadata[CHAT_METADATA_CLEANING_LIST_KEY];
        } else {
          metadata[CHAT_METADATA_CLEANING_LIST_KEY] = formatCleaningListSelection(listId);
        }
        context.saveMetadataDebounced?.();
      },
    };
  }

  /**
   * ST 正则条目（ticket 22 / ADR 0011）：全局（extension_settings.regex）+ 当前
   * 角色卡 scoped（characters[chid].data.extensions.regex_scripts）+ 当前预设
   * preset（preset manager regex_scripts），按脚本 id 去重（预设应用后条目可能
   * 同时出现在全局）。官方 getContext() 三源均可达（st-context.js 已核实）。
   */
  get stRegexEntries(): readonly StRegexEntry[] {
    const context = this.#getContext();
    const entries: StRegexEntry[] = [];
    const seen = new Set<string>();
    const push = (source: StRegexEntrySource, script: unknown): void => {
      if (!isRecord(script)) return;
      const id = typeof script.id === "string" ? script.id : undefined;
      if (id !== undefined) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      entries.push({ source, script });
    };
    const global = context.extensionSettings?.regex;
    if (Array.isArray(global)) {
      for (const script of global) push("global", script);
    }
    const chid = context.characterId;
    const character = typeof chid === "number" ? context.characters?.[chid] : undefined;
    const scoped = isRecord(character) ? (character as { data?: unknown }).data : undefined;
    const scopedScripts = isRecord(scoped)
      ? (scoped as { extensions?: unknown }).extensions
      : undefined;
    const scopedRegex = isRecord(scopedScripts)
      ? (scopedScripts as { regex_scripts?: unknown }).regex_scripts
      : undefined;
    if (Array.isArray(scopedRegex)) {
      for (const script of scopedRegex) push("scoped", script);
    }
    const presetManager = context.getPresetManager?.();
    const preset = presetManager?.readPresetExtensionField?.({ path: "regex_scripts" });
    if (Array.isArray(preset)) {
      for (const script of preset) push("preset", script);
    }
    return entries;
  }

  /**
   * 记忆宏注册端口（ticket 15 / ADR 0004）：name 为裸标识符（含花括号会被 ST
   * 校验拒绝）；宿主缺失 macros 时静默跳过（无宏引擎 = 无注入，不报错）。
   */
  get macroRegistration(): MemoryMacroRegistrationPort {
    return {
      register: (name, handler) => {
        this.#getContext().macros?.register(name, { handler });
      },
      unregister: (name) => {
        this.#getContext().macros?.registry?.unregisterMacro(name);
      },
    };
  }

  /** 注册事件桥：CHAT_CHANGED 用于切换空间上下文；消息事件仅注册（未来触发点） */
  registerEventBridge(bridge: StEventBridge): void {
    const context = this.#getContext();
    const source = context.eventSource;
    const types = context.eventTypes;
    if (!source || !types) return;
    source.on(types.CHAT_CHANGED, () => void bridge.onChatChanged());
    source.on(types.MESSAGE_SENT, () => bridge.onMessageEvent("message_sent"));
    source.on(types.MESSAGE_RECEIVED, () => bridge.onMessageEvent("message_received"));
  }

  /**
   * 按同步楼层跳转 ST 对应消息（证据楼层 chip 的底层能力）。
   * 越界（楼层不在当前已加载对话内）返回 out-of-range 由 UI 提示；消息块未加载
   * （楼层在 chat 内但 DOM 没有对应块，或非浏览器环境）返回 not-loaded。
   */
  scrollToFloor(floor: number): FloorJumpResult {
    const chatLength = this.#getContext().chat?.length ?? 0;
    const decision = resolveFloorJump(floor, chatLength);
    if (decision.kind !== "ok") return decision;
    return scrollToMessageElement(floor);
  }

  /**
   * 按同步楼层读取 ST 消息子集（证据 chip 的原文摘录数据源）。
   * 楼层越界 / 消息对象缺失 / 正文非字符串 → undefined（由 UI 决定提示）。
   * ST 1.18 消息对象形状（public/scripts 已核实）：{ mes: string, name: string,
   * is_user: boolean, ... }——此处只做字段映射，不校验其余属性。
   */
  getMessageAt(floor: number): StChatMessage | undefined {
    const chat = this.#getContext().chat;
    if (!Array.isArray(chat) || !Number.isInteger(floor) || floor < 0 || floor >= chat.length) {
      return undefined;
    }
    const message = chat[floor];
    if (typeof message !== "object" || message === null) return undefined;
    const record = message as Record<string, unknown>;
    if (typeof record.mes !== "string") return undefined;
    return {
      floor,
      content: record.mes,
      name: typeof record.name === "string" ? record.name : "",
      isUser: record.is_user === true,
    };
  }

  /** 当前对话消息总数（填表任务范围上限 = chatMessageCount - 1；无聊天数组按 0）。 */
  chatMessageCount(): number {
    const chat = this.#getContext().chat;
    return Array.isArray(chat) ? chat.length : 0;
  }

  /** 当前对话身份（ST chatId；未保存对话为 undefined）——填表任务的对话切换检测。 */
  chatId(): string | undefined {
    return this.#getContext().chatId || undefined;
  }

  /**
   * 填表任务消息来源：闭区间 [from, to] 楼层升序的消息（含格式化标记的原文），
   * 越界/缺正文楼层跳过（漂移接受，ADR 0003）。getMessageAt 的批量形态。
   */
  messagesInRange(from: number, to: number): readonly StChatMessage[] {
    const messages: StChatMessage[] = [];
    for (let floor = from; floor <= to; floor += 1) {
      const message = this.getMessageAt(floor);
      if (message) messages.push(message);
    }
    return messages;
  }
}

/** 读取 chatMetadata 里的绑定：键缺失 = none；键存在但值无法识别（损坏/未来版本）= unrecognized */
function readChatSpaceBinding(metadata: Record<string, unknown> | undefined): ChatBindingStoreRead {
  const raw = metadata?.[CHAT_METADATA_BINDING_KEY];
  if (raw === undefined) return { kind: "none" };
  if (isChatSpaceBinding(raw)) return { kind: "bound", binding: raw };
  return { kind: "unrecognized" };
}

function isChatSpaceBinding(value: unknown): value is ChatSpaceBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.spaceId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** DOM 部分：ST 消息块 `.mes[mesid="N"]`（下标 = 同步楼层）。ST DOM 不测（测试决策）。 */
function scrollToMessageElement(floor: number): FloorJumpResult {
  if (typeof document === "undefined") return { kind: "not-loaded" };
  const container = document.getElementById("chat");
  const element = document.querySelector(`#chat .mes[mesid="${floor}"]`);
  if (!(container instanceof HTMLElement) || !(element instanceof HTMLElement)) {
    return { kind: "not-loaded" };
  }
  // 与 ST 自身 /scroll-to-message 同法（slash-commands.js）：容器内相对滚动 + 高亮；
  // 动效尊重 reduced-motion（spec UI 契约：动效只留抽屉开合与同步状态变化）
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  container.scrollTo({
    top: elementRect.top - containerRect.top + container.scrollTop,
    behavior: reducedMotion ? "auto" : "smooth",
  });
  element.classList.add("stm-floor-flash");
  window.setTimeout(() => element.classList.remove("stm-floor-flash"), 2000);
  return { kind: "jumped" };
}
