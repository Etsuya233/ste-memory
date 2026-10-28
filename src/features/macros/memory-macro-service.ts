import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import { createReadTimeDisplayTextResolver } from "../memory/index.ts";
import type { MemoryMacro } from "./macro-expression.ts";
import { migrateMemoryView } from "./macro-expression.ts";
import type { MemoryView } from "./memory-views.ts";
import type { MacroEvaluationBatch } from "./macro-evaluation.ts";
import { assembleMemoryContextSnapshot } from "./memory-context-snapshot.ts";
import { renderMemoryFullSnapshot, sanitizeMacroSyntax } from "./memory-view-render.ts";
import { resolveMacroRegistrationName } from "./macro-name.ts";
import { renderMacroResult } from "./macro-result-render.ts";

export const BUILTIN_FULL_ARG = "full";
export interface MemoryMacroExecutionContext {
  readonly unnamedArgs?: readonly string[];
}
export interface MemoryMacroArgSpec {
  readonly name: string;
  readonly optional?: boolean;
  readonly defaultValue?: string;
}
export const MEMORY_MACRO_NAME_ARG: MemoryMacroArgSpec = {
  name: "name",
  optional: true,
  defaultValue: "",
};
export interface MemoryMacroRegistrationPort {
  register(
    name: string,
    handler: (context: MemoryMacroExecutionContext) => string,
    args?: readonly MemoryMacroArgSpec[],
  ): void;
  unregister(name: string): void;
}

export interface MacroExecutionResult {
  readonly id: string;
  readonly name: string;
  readonly scope: "chat" | "global" | "builtin";
  readonly status:
    "not-run" | "disabled" | "running" | "success" | "empty" | "error" | "cancelled" | "stale";
  readonly text: string;
  readonly error: string | null;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly resultRows: number;
  readonly outputRows: number;
  readonly truncated: boolean;
  readonly diagnostics: readonly unknown[];
}

export interface MacroMigrationConflict {
  readonly name: string;
  readonly source: string;
  readonly existing: MemoryMacro;
  readonly legacy: MemoryMacro;
}

export interface MemoryMacroServicePorts {
  readonly getContext: () => string;
  readonly getChatMacros: () => readonly MemoryMacro[];
  readonly saveChatMacros: (macros: readonly MemoryMacro[]) => Promise<void>;
  readonly readLegacyChatMacros: () => readonly MemoryView[];
  readonly writeLegacyChatMacros: (macros: readonly MemoryView[]) => void;
  readonly readSettings: () => {
    readonly enabled: boolean;
    readonly macroName: string;
    readonly macroLimit: number;
    readonly macros: readonly MemoryMacro[];
  };
  readonly capture: () => Promise<MemorySpaceBackup | undefined>;
  readonly createBatch: (
    snapshot: MemorySpaceBackup,
    context: { lastUserMessage: string | null; signal: AbortSignal; deadline: number },
  ) => Promise<MacroEvaluationBatch>;
  readonly registerMacro: MemoryMacroRegistrationPort;
  readonly now?: () => string;
  readonly timeoutMs?: number;
}

/** Generation-scoped evaluation. Registration and invalidation never query memory. */
export class MemoryMacroService {
  readonly #ports: MemoryMacroServicePorts;
  readonly #listeners = new Set<() => void>();
  #registeredName: string | undefined;
  #results: readonly MacroExecutionResult[] = [];
  #conflicts: readonly MacroMigrationConflict[] = [];
  #migrationError: string | null = null;
  #controller: AbortController | undefined;
  #epoch = 0;
  #readable = false;
  #building = false;
  #waitingMessage = false;
  #group = false;
  #groupPrepared = false;
  #preparing = false;
  #reuseBatch = false;
  #publishedContext: string | undefined;

  constructor(ports: MemoryMacroServicePorts) {
    this.#ports = ports;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getRecentResults = (): readonly MacroExecutionResult[] => this.#results;
  getMigrationConflicts = (): readonly MacroMigrationConflict[] => this.#conflicts;
  getMigrationError = (): string | null => this.#migrationError;

  async start(): Promise<void> {
    await this.kick();
  }

  stop(): void {
    this.cancel("宏计算已停止");
    if (this.#registeredName) this.#ports.registerMacro.unregister(this.#registeredName);
    this.#registeredName = undefined;
  }

  /** Settings changes affect registration and the next batch, never trigger evaluation. */
  async kick(): Promise<void> {
    const settings = this.#ports.readSettings();
    const name = settings.enabled ? resolveMacroRegistrationName(settings.macroName) : undefined;
    if (name !== this.#registeredName) {
      if (this.#registeredName) this.#ports.registerMacro.unregister(this.#registeredName);
      this.#registeredName = name;
      if (name)
        this.#ports.registerMacro.register(
          name,
          (context) => {
            if (
              !this.#readable ||
              !this.#building ||
              this.#publishedContext !== this.#ports.getContext() ||
              !this.#ports.readSettings().enabled
            )
              return "";
            const macroName = context.unnamedArgs?.[0] ?? "";
            if (this.#migrationError && macroName !== "") return "";
            return this.#results.find((result) => result.name === macroName)?.text ?? "";
          },
          [MEMORY_MACRO_NAME_ARG],
        );
    }
    if (!settings.enabled) this.cancel("插件已停用");
    this.markStale();
  }

  markStale(): void {
    if (this.#building || !this.#results.length) return;
    this.#results = this.#results.map((result) => ({ ...result, status: "stale" }));
    this.#notify();
  }

  chatChanged(): void {
    this.cancel("对话已切换");
    this.#group = false;
    this.#groupPrepared = false;
    this.#results = [];
    this.#conflicts = [];
    this.#migrationError = null;
    this.#notify();
  }

  cancel(reason = "宏计算已取消"): void {
    this.#controller?.abort(new Error(reason));
    this.#epoch++;
    this.#readable = false;
    this.#building = false;
    this.#waitingMessage = false;
    this.#preparing = false;
    this.#reuseBatch = false;
    if (this.#results.some((result) => result.status === "running")) {
      this.#results = this.#results.map((result) =>
        result.status === "running"
          ? { ...result, status: "cancelled", text: "", error: reason }
          : result,
      );
      this.#notify();
    }
  }

  skip = (): void => {
    this.#controller?.abort(new Error("已跳过本次宏计算"));
  };

  isPreparing = (): boolean => this.#preparing;

  groupStarted(): void {
    this.#group = true;
    this.#groupPrepared = false;
  }

  groupEnded(): void {
    this.#group = false;
    this.#groupPrepared = false;
    this.#building = false;
    this.#readable = false;
  }

  started(
    type: unknown,
    options: { automatic_trigger?: boolean; continuation?: boolean },
    dryRun: boolean,
  ): void {
    if (dryRun || type === "quiet" || type === "impersonate") return;
    if (options.continuation || (this.#group && this.#groupPrepared)) {
      this.#building = true;
      this.#readable = this.#results.length > 0;
      this.#reuseBatch = true;
      return;
    }
    this.cancel("新的生成操作");
    this.#building = true;
    this.#waitingMessage = (type === undefined || type === "normal") && !options.automatic_trigger;
  }

  async afterCommands(
    type: unknown,
    options: { automatic_trigger?: boolean },
    dryRun: boolean,
    lastUserMessage: string | null,
  ): Promise<void> {
    if (dryRun || type === "quiet" || type === "impersonate") return;
    if (this.#reuseBatch) return;
    if (this.#group && this.#groupPrepared) return;
    if (!this.#waitingMessage || options.automatic_trigger) await this.prepare(lastUserMessage);
  }

  async messageSent(message: { content: string; isUser: boolean } | undefined): Promise<void> {
    if (!this.#waitingMessage || !message?.isUser) return;
    this.#waitingMessage = false;
    await this.prepare(message.content);
  }

  generationFinished(dryRun: boolean): void {
    if (dryRun) return;
    this.#building = false;
    this.#readable = false;
  }

  async migrateLegacyChatMacros(): Promise<void> {
    const context = this.#ports.getContext();
    let legacyViews: readonly MemoryView[];
    try {
      legacyViews = this.#ports.readLegacyChatMacros();
      this.#migrationError = null;
    } catch (error) {
      this.#migrationError = `旧对话宏无法迁移，原始数据已保留，命名宏暂停展开：${error instanceof Error ? error.message : String(error)}`;
      this.#notify();
      return;
    }
    if (!legacyViews.length) {
      this.#conflicts = [];
      this.#notify();
      return;
    }
    const current = [...this.#ports.getChatMacros()];
    const conflicts: MacroMigrationConflict[] = [];
    const pending: MemoryView[] = [];
    let changed = false;
    for (const view of legacyViews) {
      const legacy = migrateMemoryView(
        view,
        `legacy-chat:${encodeURIComponent(context)}:${encodeURIComponent(view.name)}`,
      );
      const existing = current.find((macro) => macro.name === view.name);
      if (!existing) {
        current.push(legacy);
        changed = true;
      } else {
        const definition = (macro: MemoryMacro) => JSON.stringify({ ...macro, id: "" });
        if (definition(existing) !== definition(legacy)) {
          conflicts.push({ name: view.name, source: context, existing, legacy });
          pending.push(view);
        }
      }
    }
    if (changed) await this.#ports.saveChatMacros(current);
    if (context !== this.#ports.getContext()) return;
    this.#ports.writeLegacyChatMacros(pending);
    this.#conflicts = conflicts;
    this.#notify();
  }

  async resolveMigrationConflict(
    name: string,
    resolution: { kind: "keep" | "overwrite" | "rename"; name?: string },
  ): Promise<void> {
    const context = this.#ports.getContext();
    const conflict = this.#conflicts.find((item) => item.name === name);
    if (!conflict) throw new Error("迁移冲突已不存在");
    const macros = [...this.#ports.getChatMacros()];
    if (resolution.kind === "overwrite") {
      const index = macros.findIndex((macro) => macro.name === name);
      if (index < 0) throw new Error("空间中的同名宏已改变，请重新打开对话");
      macros[index] = conflict.legacy;
    } else if (resolution.kind === "rename") {
      const newName = resolution.name?.trim();
      if (!newName || macros.some((macro) => macro.name === newName))
        throw new Error("请输入尚未使用的宏名");
      macros.push({
        ...conflict.legacy,
        id: `${conflict.legacy.id}:${encodeURIComponent(newName)}`,
        name: newName,
      });
    }
    if (resolution.kind !== "keep") await this.#ports.saveChatMacros(macros);
    if (context !== this.#ports.getContext()) throw new Error("对话已切换");
    this.#ports.writeLegacyChatMacros(
      this.#ports.readLegacyChatMacros().filter((view) => view.name !== name),
    );
    this.#conflicts = this.#conflicts.filter((item) => item.name !== name);
    this.#notify();
  }

  async testMacro(input: {
    macro: MemoryMacro;
    scope: "chat" | "global";
    lastUserMessage: string | null;
  }): Promise<MacroExecutionResult> {
    const controller = new AbortController();
    const started = performance.now();
    const initial = this.#initial(input.macro, input.scope);
    const deadline = started + (this.#ports.timeoutMs ?? 10_000);
    let batch: MacroEvaluationBatch | undefined;
    const interrupted = new Promise<MacroExecutionResult>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          resolve({
            ...initial,
            status: "error",
            error: "测试超过允许的计算时限",
            elapsedMs: performance.now() - started,
            diagnostics: batch ? [{ execution: batch.statistics(input.macro.expression) }] : [],
          }),
        { once: true },
      );
    });
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
    const work = async (): Promise<MacroExecutionResult> => {
      try {
        const snapshot = await this.#ports.capture();
        controller.signal.throwIfAborted();
        if (!snapshot) throw new Error("当前记忆空间尚未准备好");
        batch = await this.#ports.createBatch(snapshot, {
          lastUserMessage: input.lastUserMessage,
          signal: controller.signal,
          deadline,
        });
        const result = await batch.evaluate(input.macro.expression);
        controller.signal.throwIfAborted();
        const rendered = renderMacroResult(
          input.macro,
          result,
          this.#ports.readSettings().macroLimit,
        );
        return {
          ...initial,
          ...rendered,
          status: result.rows.length ? "success" : "empty",
          resultRows: result.rows.length,
          elapsedMs: performance.now() - started,
          diagnostics: [
            { execution: { ...batch.statistics(input.macro.expression), ...result.execution } },
            {
              expression: input.macro.expression,
              lastUserMessage: input.lastUserMessage,
              scope: input.scope,
            },
            ...result.sources.map(({ rows, ...source }) => ({
              ...source,
              scoredRecords: rows.length,
            })),
          ],
        };
      } catch (error) {
        return {
          ...initial,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: performance.now() - started,
          diagnostics: batch ? [{ execution: batch.statistics(input.macro.expression) }] : [],
        };
      } finally {
        await batch?.close();
      }
    };
    try {
      return await Promise.race([work(), interrupted]);
    } catch (error) {
      return {
        ...initial,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: performance.now() - started,
        diagnostics: batch ? [{ execution: batch.statistics(input.macro.expression) }] : [],
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async prepare(lastUserMessage: string | null): Promise<void> {
    if (!this.#ports.readSettings().enabled || (this.#group && this.#groupPrepared)) return;
    const epoch = ++this.#epoch;
    const context = this.#ports.getContext();
    const settings = this.#ports.readSettings();
    const controller = new AbortController();
    this.#controller = controller;
    this.#preparing = true;
    this.#building = true;
    this.#readable = false;
    const deadline = performance.now() + (this.#ports.timeoutMs ?? 10_000);
    const selected = new Map<string, { macro: MemoryMacro; scope: "chat" | "global" }>();
    for (const macro of settings.macros) selected.set(macro.name, { macro, scope: "global" });
    for (const macro of this.#ports.getChatMacros())
      selected.set(macro.name, { macro, scope: "chat" });
    const results = new Map<string, MacroExecutionResult>();
    for (const { macro, scope } of selected.values()) {
      const conflict =
        this.#migrationError || this.#conflicts.some((item) => item.name === macro.name);
      results.set(macro.name, {
        ...this.#initial(macro, scope),
        status: conflict ? "error" : macro.enabled ? "running" : "disabled",
        error: this.#migrationError ?? (conflict ? "该名称存在旧对话宏迁移冲突，请先处理" : null),
      });
    }
    this.#results = [...results.values()];
    this.#notify();
    const timer = setTimeout(
      () => controller.abort(new Error("本次宏计算超过 10 秒")),
      Math.max(0, deadline - performance.now()),
    );
    let release!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      release = resolve;
    });
    controller.signal.addEventListener("abort", release, { once: true });
    let batch: MacroEvaluationBatch | undefined;
    const work = async () => {
      try {
        const snapshot = await this.#ports.capture();
        controller.signal.throwIfAborted();
        if (!snapshot) throw new Error("当前记忆空间尚未准备好");
        const builtins = await this.#builtins(snapshot, settings.macroLimit);
        for (const result of builtins)
          if (!selected.has(result.name))
            results.set(
              result.name,
              this.#migrationError && result.name !== ""
                ? { ...result, status: "error", text: "", error: this.#migrationError }
                : result,
            );
        batch = await this.#ports.createBatch(snapshot, {
          lastUserMessage,
          signal: controller.signal,
          deadline,
        });
        await Promise.all(
          [...selected.values()].map(async ({ macro }) => {
            const initial = results.get(macro.name)!;
            if (initial.status !== "running") return;
            const started = performance.now();
            try {
              const result = await batch!.evaluate(macro.expression);
              controller.signal.throwIfAborted();
              const rendered = renderMacroResult(macro, result, settings.macroLimit);
              results.set(macro.name, {
                ...initial,
                ...rendered,
                status: result.rows.length ? "success" : "empty",
                resultRows: result.rows.length,
                elapsedMs: performance.now() - started,
                diagnostics: [
                  { execution: { ...batch!.statistics(macro.expression), ...result.execution } },
                  { expression: macro.expression, lastUserMessage, scope: initial.scope },
                  ...result.sources.map(({ rows, ...source }) => ({
                    ...source,
                    scoredRecords: rows.length,
                  })),
                ],
              });
            } catch (error) {
              results.set(macro.name, {
                ...initial,
                status: "error",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: performance.now() - started,
                diagnostics: [{ execution: batch!.statistics(macro.expression) }],
              });
            }
          }),
        );
      } catch (error) {
        for (const [name, result] of results)
          if (result.status === "running")
            results.set(name, {
              ...result,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
      } finally {
        try {
          await batch?.close();
        } catch (error) {
          for (const [name, result] of results) {
            if (result.scope === "builtin") continue;
            const definition = selected.get(name)!.macro;
            results.set(name, {
              ...result,
              status: "error",
              text: "",
              error: `宏求值会话关闭失败：${error instanceof Error ? error.message : String(error)}`,
              diagnostics: batch ? [{ execution: batch.statistics(definition.expression) }] : [],
            });
          }
        }
      }
    };
    try {
      await Promise.race([work(), interrupted]);
      if (epoch !== this.#epoch || context !== this.#ports.getContext()) return;
      for (const [name, result] of results)
        if (result.status === "running")
          results.set(name, {
            ...result,
            status: "error",
            error:
              controller.signal.reason instanceof Error
                ? controller.signal.reason.message
                : "宏计算超时",
            diagnostics:
              batch && selected.has(name)
                ? [{ execution: batch.statistics(selected.get(name)!.macro.expression) }]
                : [],
          });
      this.#results = [...results.values()];
      this.#publishedContext = context;
      this.#readable = true;
      this.#groupPrepared = this.#group;
      this.#notify();
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", release);
      if (epoch === this.#epoch) this.#preparing = false;
    }
  }

  getSnapshot(): string {
    return this.#results.find((result) => result.name === "")?.text ?? "";
  }
  getViewSnapshot(name: string): string | undefined {
    return this.#results.find((result) => result.name === name && result.scope === "global")?.text;
  }
  getChatScopeSnapshot(name: string): string | undefined {
    return this.#results.find((result) => result.name === name && result.scope === "chat")?.text;
  }
  builtinSnapshotNames(): readonly string[] {
    return this.#results
      .filter((result) => result.scope === "builtin" && result.name !== "")
      .map((result) => result.name);
  }
  getBuiltinSnapshot(name: string): string | undefined {
    return this.#results.find((result) => result.name === name && result.scope === "builtin")?.text;
  }

  #initial(
    macro: Pick<MemoryMacro, "id" | "name">,
    scope: MacroExecutionResult["scope"],
  ): MacroExecutionResult {
    return {
      id: macro.id,
      name: macro.name,
      scope,
      status: "not-run",
      text: "",
      error: null,
      startedAt: this.#ports.now?.() ?? new Date().toISOString(),
      elapsedMs: 0,
      resultRows: 0,
      outputRows: 0,
      truncated: false,
      diagnostics: [],
    };
  }

  async #builtins(
    snapshot: MemorySpaceBackup,
    limit: number,
  ): Promise<readonly MacroExecutionResult[]> {
    const display = createReadTimeDisplayTextResolver({
      getTable: async (id) => snapshot.tables.find((table) => table.id === id),
      getFields: async (id) => snapshot.fields.filter((field) => field.tableId === id),
      findRecord: async (tableId, recordId) =>
        snapshot.records.find((record) => record.tableId === tableId && record.id === recordId),
    });
    const records = await Promise.all(
      snapshot.records.map(async (record) => ({ ...record, displayText: await display(record) })),
    );
    const tables = snapshot.tables.filter((table) => table.enabled);
    const inputs = tables.map((table) => ({
      name: table.name,
      fields: snapshot.fields
        .filter((field) => field.tableId === table.id && field.enabled)
        .map((field) => ({ id: field.id, name: field.name })),
      records: records
        .filter((record) => record.tableId === table.id)
        .map((record) => {
          const payload = new Map(Object.entries(record.payload));
          for (const field of snapshot.fields) {
            if (
              field.tableId !== table.id ||
              !field.enabled ||
              (field.type !== "single_reference" && field.type !== "multi_reference")
            )
              continue;
            const value = payload.get(field.id);
            if (value === null || value === undefined) continue;
            const ids = field.type === "multi_reference" ? (value as readonly string[]) : [value];
            const names = ids.map(
              (id) =>
                records.find(
                  (target) => target.tableId === field.referenceTableId && target.id === id,
                )!.displayText,
            );
            payload.set(field.id, field.type === "multi_reference" ? names : names[0]!);
          }
          return { payload, displayText: record.displayText };
        }),
    }));
    const texts = new Map<string, string>([
      [
        "",
        sanitizeMacroSyntax(
          assembleMemoryContextSnapshot(
            tables.map((table) => ({
              name: table.name,
              enabled: true,
              records: records.filter((record) => record.tableId === table.id),
            })),
            limit,
          ),
        ),
      ],
      [BUILTIN_FULL_ARG, renderMemoryFullSnapshot({ tables: inputs, limit })],
    ]);
    for (const [index, table] of tables.entries())
      if (table.key !== BUILTIN_FULL_ARG)
        texts.set(table.key, renderMemoryFullSnapshot({ tables: [inputs[index]!], limit }));
    return [...texts].map(([name, text]) => ({
      ...this.#initial({ id: `builtin:${name}`, name }, "builtin"),
      status: text ? "success" : "empty",
      text,
    }));
  }

  #notify(): void {
    this.#results = [...this.#results];
    for (const listener of this.#listeners) listener();
  }
}
