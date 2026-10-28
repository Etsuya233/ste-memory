import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus, Trash2, Variable } from "lucide-react";
import type { MemoryFieldService, MemoryTableService } from "../../../features/memory/index.ts";
import type { MemoryMacro } from "../../../features/macros/macro-expression.ts";
import type {
  MemoryMacroService,
  MacroExecutionResult,
} from "../../../features/macros/memory-macro-service.ts";
import type { MacroOverviewRow } from "../../../features/macros/macro-overview-model.ts";
import { resolveMacroRegistrationName } from "../../../features/macros/macro-name.ts";
import type { SettingsService } from "../../../features/settings/settings-service.ts";
import {
  macroFromEditorDraft,
  type ExpressionMacroDraft,
} from "../../../ui/settings/expression-macro-editor-model.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import { PageHeader, PageContent } from "../../components/page-layout.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import type { RecordsContext } from "../records-workspace.ts";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";
import { macroEditorDraft, macroWasSaved, mergeEditedMacro } from "./macros-model.ts";
import { MacroEditorFields, type MacroSchema } from "./macros-editor.tsx";

export interface MacroServices {
  settings: Pick<
    SettingsService,
    "setMacroName" | "setMacroLimit" | "setMacros" | "setChatScopeMacros"
  >;
  readChatMacros: () => readonly MemoryMacro[];
  macro: Pick<MemoryMacroService, "subscribe" | "getRecentResults" | "testMacro">;
  overview: () => readonly MacroOverviewRow[];
  tables: Pick<MemoryTableService, "list">;
  fields: Pick<MemoryFieldService, "list">;
  assertContext: (context: RecordsContext) => void;
}
type Scope = "global" | "chat";
interface EditorState {
  initial: MemoryMacro;
  original: MemoryMacro | null;
  draft: ExpressionMacroDraft;
  baseline: ExpressionMacroDraft;
  busy: boolean;
  error: string | null;
  notice: string | null;
  input: string;
  result: MacroExecutionResult | null;
  operation: number;
}
export interface MacrosPageProps extends SettingsSubpageProps {
  macroServices: MacroServices;
  context: RecordsContext | null;
}

export function MacrosPage(props: MacrosPageProps) {
  const { services, macroServices, context } = props;
  const [page, setPage] = useState<"overview" | "defaults" | Scope>("overview");
  const [editors, setEditors] = useState<Record<string, EditorState>>({});
  const [schema, setSchema] = useState<readonly MacroSchema[]>([]);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [deletion, setDeletion] = useState<{
    macro: MemoryMacro;
    scope: Scope;
    context: RecordsContext | null;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const recent = useSyncExternalStore(
    macroServices.macro.subscribe,
    macroServices.macro.getRecentResults,
  );
  const chatKey = JSON.stringify([context?.chatKey, context?.spaceId]);
  const contextVersion = useRef({ key: chatKey, value: 0 });
  if (contextVersion.current.key !== chatKey)
    contextVersion.current = { key: chatKey, value: contextVersion.current.value + 1 };
  const key = page === "chat" ? chatKey : "global";
  const editor = page === "global" || page === "chat" ? editors[key] : undefined;
  const dirty = Object.values(editors).some(
    (item) => JSON.stringify(item.draft) !== JSON.stringify(item.baseline),
  );
  const busy = deleting || Object.values(editors).some((item) => item.busy);
  const { requestLeave, confirmation } = usePageLeave({
    dirty,
    busy,
    scope: "macros",
    discard: () => setEditors({}),
    register: page === "defaults" ? undefined : props.registerLeaveGuard,
  });
  useEffect(() => {
    if (!dirty && !busy) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty, busy]);
  useEffect(() => {
    setDeletion(null);
    setNotice(null);
  }, [chatKey]);
  useEffect(() => {
    let cancelled = false;
    setSchema([]);
    setSchemaError(null);
    if (context)
      void macroServices.tables
        .list(context.spaceId)
        .then(async (tables) =>
          Promise.all(
            tables.map(async (table) => ({
              table,
              fields: await macroServices.fields.list(context.spaceId, table.id),
            })),
          ),
        )
        .then(
          (rows) => {
            if (!cancelled) setSchema(rows);
          },
          (cause: unknown) => {
            if (!cancelled) setSchemaError(cause instanceof Error ? cause.message : String(cause));
          },
        );
    return () => {
      cancelled = true;
    };
  }, [context?.chatKey, context?.spaceId, macroServices]);
  const settings = services.settings.read();
  const global = settings.macros;
  const chat = context ? macroServices.readChatMacros() : [];
  const list = page === "chat" ? chat : global;
  const label = page === "chat" ? "对话宏" : "全局宏";
  const prefix = resolveMacroRegistrationName(settings.macroName);
  function patchEditor(editKey: string, patch: Partial<EditorState>, operation?: number) {
    setEditors((current) => {
      const value = current[editKey];
      if (!value || (operation !== undefined && value.operation !== operation)) return current;
      return { ...current, [editKey]: { ...value, ...patch } };
    });
  }
  function closeEditor(editKey: string) {
    setEditors((current) => {
      const next = { ...current };
      delete next[editKey];
      return next;
    });
  }
  function begin(macro?: MemoryMacro) {
    const initial: MemoryMacro = macro ?? {
      id: crypto.randomUUID(),
      name: "",
      enabled: false,
      expression: { language: "query", query: { table: schema[0]?.table.key ?? "", limit: 10 } },
      output: { format: "text", maxChars: null },
    };
    const draft = macroEditorDraft(initial, schema[0]?.table.key ?? "");
    setEditors((current) => ({
      ...current,
      [key]: {
        initial,
        original: macro ?? null,
        draft,
        baseline: draft,
        busy: false,
        error: null,
        notice: null,
        input: "",
        result: null,
        operation: 0,
      },
    }));
  }
  function readCollection(scope: Scope, captured: RecordsContext | null) {
    if (scope === "global") return services.settings.read().macros;
    if (!captured) throw new Error("请先打开对话");
    macroServices.assertContext(captured);
    return macroServices.readChatMacros();
  }
  async function saveEditor() {
    if (!editor || (page !== "global" && page !== "chat")) return;
    const scope = page,
      editKey = key,
      captured = context,
      operation = editor.operation + 1;
    patchEditor(editKey, { busy: true, error: null, notice: null, operation });
    try {
      const current = readCollection(scope, captured);
      const desired = macroFromEditorDraft(
        editor.initial,
        editor.draft,
        current.filter((item) => item.id !== editor.initial.id).map((item) => item.name),
      );
      const next = mergeEditedMacro(current, editor.original, desired);
      const result = await persistSettingsEdit(
        services,
        () =>
          scope === "global"
            ? macroServices.settings.setMacros(next)
            : macroServices.settings.setChatScopeMacros(next),
        () =>
          macroWasSaved(
            readCollection(scope, captured).find((item) => item.id === desired.id),
            desired,
            !editor.original,
          ),
      );
      if (result.saved) {
        const saved = readCollection(scope, captured).find((item) => item.id === desired.id)!;
        const savedDraft = macroEditorDraft(saved, schema[0]?.table.key ?? "");
        patchEditor(
          editKey,
          {
            initial: saved,
            original: saved,
            draft: savedDraft,
            baseline: savedDraft,
            result: null,
            notice: result.error
              ? `宏已保存，后续刷新失败：${result.error}`
              : saved.enabled !== desired.enabled
                ? "宏已保存。新建语义宏默认停用，确认后可以再次启用。"
                : "宏已保存。",
            error: null,
          },
          operation,
        );
      } else
        patchEditor(editKey, { error: result.error ?? "宏未保存，请检查定义后重试。" }, operation);
    } catch (cause) {
      patchEditor(
        editKey,
        { error: cause instanceof Error ? cause.message : String(cause) },
        operation,
      );
    } finally {
      patchEditor(editKey, { busy: false }, operation);
    }
  }
  async function testEditor() {
    if (!editor || !context || (page !== "global" && page !== "chat")) return;
    const version = contextVersion.current.value;
    const scope = page,
      editKey = key,
      captured = context,
      operation = editor.operation + 1;
    patchEditor(editKey, { busy: true, error: null, result: null, operation });
    try {
      macroServices.assertContext(captured);
      const desired = macroFromEditorDraft(
        editor.initial,
        editor.draft,
        list.filter((item) => item.id !== editor.initial.id).map((item) => item.name),
      );
      const result = await macroServices.macro.testMacro({
        macro: desired,
        scope,
        lastUserMessage: editor.input.trim() || null,
      });
      macroServices.assertContext(captured);
      if (version !== contextVersion.current.value)
        throw new Error("测试期间对话已切换，请在当前对话重新测试。");
      patchEditor(editKey, { result }, operation);
    } catch (cause) {
      patchEditor(
        editKey,
        { error: cause instanceof Error ? cause.message : String(cause) },
        operation,
      );
    } finally {
      patchEditor(editKey, { busy: false }, operation);
    }
  }
  async function remove() {
    if (!deletion) return;
    const selected = deletion;
    setDeleting(true);
    try {
      const next = readCollection(selected.scope, selected.context).filter(
        (item) => item.id !== selected.macro.id,
      );
      const result = await persistSettingsEdit(
        services,
        () =>
          selected.scope === "global"
            ? macroServices.settings.setMacros(next)
            : macroServices.settings.setChatScopeMacros(next),
        () =>
          !readCollection(selected.scope, selected.context).some(
            (item) => item.id === selected.macro.id,
          ),
      );
      if (!result.saved) throw new Error(result.error ?? "宏未删除");
      setNotice({
        text: result.error ? `宏已删除，后续刷新失败：${result.error}` : "宏已删除。",
        error: !!result.error,
      });
    } finally {
      setDeleting(false);
    }
  }
  if (page === "defaults") return <MacroDefaults {...props} onBack={() => setPage("overview")} />;
  if (editor)
    return (
      <>
        <SettingsEditor
          title={`${label}：${editor.draft.name || "新建宏"}`}
          scope={`macro-editor-${key}`}
          controls={props.controls}
          onBack={() => closeEditor(key)}
          dirty={JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline)}
          busy={editor.busy}
          onDiscard={() => closeEditor(key)}
          onSave={() => void saveEditor()}
          error={editor.error}
          notice={editor.notice}
        >
          <MacroEditorFields
            initial={editor.initial}
            draft={editor.draft}
            onChange={(draft) =>
              patchEditor(key, { draft, result: null, error: null, notice: null })
            }
            schema={schema}
            input={editor.input}
            onInputChange={(input) => patchEditor(key, { input, result: null })}
            result={editor.result}
            onTest={() => void testEditor()}
            canTest={!!context}
            schemaError={schemaError}
            recent={recent.find((item) => item.id === editor.initial.id && item.scope === page)}
          />
        </SettingsEditor>
        {confirmation}
      </>
    );
  const back = () => requestLeave(page === "overview" ? props.onBack : () => setPage("overview"));
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={page === "overview" ? "记忆宏" : label}
        subtitle={page === "chat" ? context?.title : "全局设置"}
        icon={Variable}
        {...props.controls}
        onBack={back}
        busy={busy}
        actions={
          page === "global" || page === "chat" ? (
            <Button
              disabled={busy || (page === "chat" && !context)}
              onClick={() => begin()}
              data-action="create-macro"
            >
              <Plus data-icon="inline-start" />
              新建宏
            </Button>
          ) : undefined
        }
      />
      <PageContent>
        <div className="ste:mx-auto ste:flex ste:max-w-3xl ste:flex-col ste:gap-4">
          {notice ? (
            <StatusNotice variant={notice.error ? "destructive" : "default"}>
              {notice.text}
            </StatusNotice>
          ) : null}
          {page === "overview" ? (
            <>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => setPage("defaults")}
              >
                <span>
                  前缀与输出上限
                  <br />
                  <span className="ste:text-xs ste:text-muted-foreground">
                    {settings.macroName || "未注册"} · 每个宏 {settings.macroLimit} 字符
                  </span>
                </span>
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => setPage("global")}
              >
                全局宏 · {global.length} 个<ChevronRight />
              </Button>
              <Button
                variant="outline"
                className="ste:h-auto ste:justify-between ste:py-4"
                onClick={() => setPage("chat")}
                disabled={!context}
              >
                当前对话宏 · {chat.length} 个<ChevronRight />
              </Button>
              <p className="ste:text-sm ste:text-muted-foreground">
                对话宏优先于全局宏和内置宏。停用仍占用同名位置，删除后才会使用下一层定义；对话宏随记忆空间保存。
              </p>
              <Accordion>
                <AccordionItem>
                  <AccordionTrigger>可用宏与最近展开内容</AccordionTrigger>
                  <AccordionContent>
                    <div className="ste:flex ste:flex-col ste:gap-4">
                      {macroServices.overview().length ? (
                        macroServices.overview().map((row) => (
                          <div key={row.name}>
                            <code className="ste:text-xs ste:break-all">{row.name}</code>
                            <pre className="ste:mt-2 ste:max-h-60 ste:overflow-y-auto ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                              {row.text || "（空）"}
                            </pre>
                          </div>
                        ))
                      ) : (
                        <p>当前没有已注册的宏。</p>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </>
          ) : !context && page === "chat" ? (
            <PageEmpty title="请先打开对话" />
          ) : list.length ? (
            list.map((macro) => (
              <div key={macro.id} className="ste:flex ste:items-center ste:gap-2">
                <Button
                  variant="outline"
                  className="ste:h-auto ste:min-w-0 ste:flex-1 ste:flex-col ste:items-start ste:gap-2 ste:py-4 ste:text-left ste:whitespace-normal"
                  onClick={() => begin(macro)}
                  disabled={busy}
                >
                  <span className="ste:break-all">
                    {prefix ? `{{${prefix}::${macro.name}}}` : macro.name}
                  </span>
                  <span className="ste:flex ste:flex-wrap ste:gap-2">
                    <Badge variant={macro.enabled ? "secondary" : "outline"}>
                      {macro.enabled ? "已启用" : "已停用"}
                    </Badge>
                    <Badge variant="outline">
                      {macro.expression.language === "sql" ? "SQL" : "Query JSON"} ·{" "}
                      {macro.output.format}
                    </Badge>
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除宏 ${macro.name}`}
                  disabled={busy}
                  onClick={() => setDeletion({ macro, scope: page as Scope, context })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          ) : (
            <PageEmpty
              title={`还没有${label}`}
              description="创建查询或 SQL 表达式，把需要的记忆展开到提示词。"
            />
          )}
        </div>
      </PageContent>
      {confirmation}
      <ConfirmAction
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open) setDeletion(null);
        }}
        title={`删除宏 ${deletion?.macro.name ?? ""}？`}
        description="删除后会使用较低作用域的同名定义；没有其他定义时，该宏将不再提供内容。"
        confirmLabel="删除宏"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}

function MacroDefaults(props: MacrosPageProps) {
  const initial = props.services.settings.read();
  const [saved, setSaved] = useState({
    name: initial.macroName,
    limit: String(initial.macroLimit),
  });
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      if (draft.name.trim() && !resolveMacroRegistrationName(draft.name))
        throw new Error(
          "宏前缀须以字母开头，可包含数字、下划线和连字符，也可填写完整的 {{ste}} 形式。",
        );
      const limit = Number(draft.limit);
      if (!draft.limit.trim() || !Number.isInteger(limit) || limit < 0)
        throw new Error("输出字符上限须为 0 或正整数");
      const result = await persistSettingsEdit(
        props.services,
        async () => {
          if (props.services.settings.read().macroName !== draft.name)
            await props.macroServices.settings.setMacroName(draft.name);
          if (props.services.settings.read().macroLimit !== limit)
            await props.macroServices.settings.setMacroLimit(limit);
        },
        (settings) => settings.macroName === draft.name && settings.macroLimit === limit,
      );
      const latest = { name: result.settings.macroName, limit: String(result.settings.macroLimit) };
      setSaved(latest);
      if (result.saved) setDraft(latest);
      setNotice({
        text: result.error
          ? `${result.saved ? "设置已保存，后续刷新失败" : "设置未全部保存"}：${result.error}`
          : "宏设置已保存。",
        error: !!result.error,
      });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsEditor
      title="宏前缀与输出上限"
      scope="global-macro-defaults"
      controls={props.controls}
      onBack={props.onBack}
      registerLeaveGuard={props.registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(saved)}
      onSave={() => void save()}
      error={notice?.error ? notice.text : null}
      notice={notice && !notice.error ? notice.text : null}
    >
      <Field>
        <FieldLabel htmlFor="macro-prefix">宏前缀</FieldLabel>
        <Input
          id="macro-prefix"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="{{ste}}"
        />
        <FieldDescription>可填 ste 或 {"{{ste}}"}；留空会注销记忆宏。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="macro-limit">默认输出字符上限</FieldLabel>
        <Input
          id="macro-limit"
          type="number"
          min={0}
          step={1}
          required
          value={draft.limit}
          onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
        />
        <FieldDescription>
          每个宏分别生效，可被单个宏的上限覆盖。只输出完整结果行，JSON 保持完整结构。
        </FieldDescription>
      </Field>
    </SettingsEditor>
  );
}
