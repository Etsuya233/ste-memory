export type MacroQueryValue =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

export type MacroQueryOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "in"
  | "not_in";

export type MacroQueryInput = { readonly context: "last_user_message" } | { readonly text: string };
export interface MacroSemanticSource {
  readonly name: string;
  readonly table: string;
  readonly groups: readonly string[];
  readonly query: MacroQueryInput;
}
export interface MacroQuery {
  readonly table: string;
  readonly conditions?: readonly {
    readonly field: string;
    readonly op: MacroQueryOperator;
    readonly value: MacroQueryValue;
  }[];
  readonly fields?: readonly string[];
  readonly orderBy?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly limit?: number;
  readonly semantic?: { readonly groups: readonly string[]; readonly query: MacroQueryInput };
}
export type MacroExpression =
  | { readonly language: "query"; readonly query: MacroQuery }
  | {
      readonly language: "sql";
      readonly sources?: readonly MacroSemanticSource[];
      readonly sql: string;
      /** 由 prepare-only 读取依赖分类；导入及保存时重新编译。 */
      readonly usesSemantic?: boolean;
    };
export interface MemoryMacro {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly expression: MacroExpression;
  readonly output: {
    readonly format: "text" | "markdown" | "json";
    readonly maxChars: number | null;
  };
  readonly legacyRendering?: boolean;
}
