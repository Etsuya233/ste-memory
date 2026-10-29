import { useId } from "react";
import type { MemoryMacro, MemoryTable, MemoryField } from "../../../features/memory/index.ts";
import { effectiveVectorIndexGroups } from "../../../features/memory/index.ts";
import type { MacroExecutionResult } from "../../../features/macros/memory-macro-service.ts";
import type { ExpressionMacroDraft } from "../../models/settings/expression-macro-editor-model.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { StatusNotice } from "../../components/page-state.tsx";

export interface MacroSchema {
  table: MemoryTable;
  fields: readonly MemoryField[];
}
export function MacroEditorFields(props: {
  initial: MemoryMacro;
  draft: ExpressionMacroDraft;
  onChange: (draft: ExpressionMacroDraft) => void;
  schema: readonly MacroSchema[];
  schemaError: string | null;
  input: string;
  onInputChange: (value: string) => void;
  result: MacroExecutionResult | null;
  onTest: () => void;
  canTest: boolean;
  recent?: MacroExecutionResult;
}) {
  const id = useId();
  const { draft, initial, onChange } = props;
  const legacy =
    initial.expression.language === "sql" && initial.expression.sources?.length
      ? initial.expression
      : null;
  const locked = !!legacy && !draft.convertedLegacy;
  const result = props.result;
  return (
    <>
      <PageSection title="定义">
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>宏名</FieldLabel>
            <Input
              id={`${id}-name`}
              value={draft.name}
              required
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
            <FieldDescription>
              提示词中使用 {"{{前缀::宏名}}"}；名称在同一作用域内唯一。
            </FieldDescription>
          </Field>
          <SwitchField
            label="启用宏"
            description="停用仍占用同名位置。新建的语义宏默认停用，确认后可再次启用。"
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>表达式语言</FieldLabel>
            <NativeSelect
              id={`${id}-language`}
              value={draft.language}
              disabled={locked}
              onChange={(event) =>
                onChange({
                  ...draft,
                  language: event.target.value as ExpressionMacroDraft["language"],
                })
              }
            >
              <option value="query">Query JSON</option>
              <option value="sql">SQL</option>
            </NativeSelect>
          </Field>
        </div>
      </PageSection>
      <PageSection title="表达式">
        <div className="ste:flex ste:flex-col ste:gap-4">
          {legacy ? (
            <>
              <StatusNotice>
                此宏包含旧版命名评分源，保存时保留原表达式。转换草稿后需要手工改写
                SQL；保存校验通过后才会移除旧评分源。
              </StatusNotice>
              <Accordion>
                <AccordionItem>
                  <AccordionTrigger>查看原评分源与 SQL</AccordionTrigger>
                  <AccordionContent>
                    <pre className="ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                      {JSON.stringify(legacy, null, 2)}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <Button
                type="button"
                variant="outline"
                className="ste:self-start"
                onClick={() =>
                  onChange({
                    ...draft,
                    language: "sql",
                    sql: legacy.sql,
                    convertedLegacy: !draft.convertedLegacy,
                  })
                }
              >
                {locked ? "转为内联 SQL 草稿" : "还原旧表达式"}
              </Button>
            </>
          ) : null}
          {!locked ? (
            draft.language === "query" ? (
              <Field>
                <FieldLabel htmlFor={`${id}-query`}>Query JSON</FieldLabel>
                <Textarea
                  id={`${id}-query`}
                  data-action="macro-query"
                  rows={12}
                  className="ste:font-mono"
                  value={draft.query}
                  required
                  spellCheck={false}
                  onChange={(event) => onChange({ ...draft, query: event.target.value })}
                />
                <FieldDescription>
                  可配置 table、conditions、fields、orderBy、limit 和 semantic。
                </FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor={`${id}-sql`}>SQL 正文</FieldLabel>
                <Textarea
                  id={`${id}-sql`}
                  data-action="macro-sql"
                  rows={12}
                  className="ste:font-mono"
                  value={draft.sql}
                  required
                  spellCheck={false}
                  onChange={(event) => onChange({ ...draft, sql: event.target.value })}
                />
                <FieldDescription>
                  使用表 Key 和字段 Key。语义搜索可调用 semantic_scores(table_key, groups_json,
                  query_text)。
                </FieldDescription>
              </Field>
            )
          ) : null}
          <Accordion>
            <AccordionItem>
              <AccordionTrigger>当前对话的表与字段参考</AccordionTrigger>
              <AccordionContent>
                <div className="ste:flex ste:flex-col ste:gap-4">
                  {props.schemaError ? (
                    <StatusNotice variant="destructive">{props.schemaError}</StatusNotice>
                  ) : props.schema.length ? (
                    props.schema.map(({ table, fields }) => (
                      <div
                        key={table.id}
                        className="ste:flex ste:flex-col ste:gap-1 ste:break-words"
                      >
                        <p>
                          {table.name} · <code>{table.key}</code>
                        </p>
                        <p className="ste:text-xs ste:text-muted-foreground">
                          字段：{fields.map((field) => `${field.name} (${field.key})`).join("、")}
                        </p>
                        <p className="ste:text-xs ste:text-muted-foreground">
                          向量分组：
                          {effectiveVectorIndexGroups(table.vectorIndex, fields)
                            .map((group) => `${group.name} (${group.key})`)
                            .join("、") || "无"}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p>请打开已绑定记忆空间的对话查看表结构。</p>
                  )}
                  <pre className="ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                    {JSON.stringify(
                      {
                        table: props.schema[0]?.table.key ?? "表Key",
                        fields: ["字段Key"],
                        orderBy: { field: "$updated_at", direction: "desc" },
                        limit: 10,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </PageSection>
      <PageSection title="输出">
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-format`}>输出格式</FieldLabel>
            <NativeSelect
              id={`${id}-format`}
              value={draft.format}
              onChange={(event) =>
                onChange({ ...draft, format: event.target.value as ExpressionMacroDraft["format"] })
              }
            >
              <option value="text">文本</option>
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-max-chars`}>此宏输出字符上限</FieldLabel>
            <Input
              id={`${id}-max-chars`}
              type="number"
              min={0}
              step={1}
              placeholder="留空使用全局设置"
              value={draft.maxChars}
              onChange={(event) => onChange({ ...draft, maxChars: event.target.value })}
            />
            <FieldDescription>留空跟随全局，或填写 0 / 正整数。</FieldDescription>
          </Field>
        </div>
      </PageSection>
      <PageSection
        title="测试"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!props.canTest}
            onClick={props.onTest}
            data-action="test-macro"
          >
            测试当前草稿
          </Button>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-test-input`}>测试用用户消息</FieldLabel>
            <Textarea
              id={`${id}-test-input`}
              rows={3}
              value={props.input}
              onChange={(event) => props.onInputChange(event.target.value)}
              placeholder="语义查询使用 last_user_message 时，可在这里提供内容"
            />
            <FieldDescription>
              测试使用当前草稿和当前对话，不保存定义。语义表达式可能请求 Embedding 和重排服务。
            </FieldDescription>
          </Field>
          {!props.canTest ? (
            <p className="ste:text-xs ste:text-muted-foreground">打开对话后才能测试宏。</p>
          ) : null}
          {result ? (
            <section aria-label="宏测试结果" className="ste:flex ste:flex-col ste:gap-3">
              <h2 className="ste:text-sm ste:font-semibold">测试结果 · {result.status}</h2>
              {result.error ? (
                <StatusNotice variant="destructive">{result.error}</StatusNotice>
              ) : null}
              <p className="ste:text-xs ste:text-muted-foreground">
                查询 {result.resultRows} 行 · 输出 {result.outputRows} 行 ·{" "}
                {result.elapsedMs.toFixed(0)} ms{result.truncated ? " · 已截断" : ""}
              </p>
              <pre className="ste:max-h-80 ste:overflow-y-auto ste:whitespace-pre-wrap ste:break-words ste:text-sm">
                {result.text || "（空输出）"}
              </pre>
              {result.diagnostics.length ? (
                <Accordion>
                  <AccordionItem>
                    <AccordionTrigger>测试诊断</AccordionTrigger>
                    <AccordionContent>
                      <pre className="ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                        {JSON.stringify(result.diagnostics, null, 2)}
                      </pre>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}
            </section>
          ) : props.recent ? (
            <p className="ste:text-xs ste:text-muted-foreground">
              最近执行：{props.recent.status} · {props.recent.resultRows} 行 ·{" "}
              {props.recent.elapsedMs.toFixed(0)} ms
            </p>
          ) : null}
        </div>
      </PageSection>
    </>
  );
}
