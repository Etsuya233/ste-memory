export type DomainErrorData =
  | {
      readonly type: "memory_space_name_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_space_name_too_long";
      readonly param: { readonly maxLength: number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_key_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_key_too_long";
      readonly param: { readonly maxLength: number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_key_conflict";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_name_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_name_too_long";
      readonly param: { readonly maxLength: number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_key_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_key_too_long";
      readonly param: { readonly maxLength: number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_key_conflict";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_reference_table_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_options_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_max_chars_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_pattern_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_type_immutable";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_name_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_name_too_long";
      readonly param: { readonly maxLength: number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_position_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_display_strategy_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_field_used_by_display_strategy";
      readonly humanMsg: string;
    }
  | {
      readonly type:
        | "memory_record_display_strategy_missing"
        | "memory_record_not_found"
        | "memory_record_paging_invalid"
        | "memory_record_source_invalid";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_record_query_invalid";
      readonly param: {
        readonly tableId: unknown;
        readonly fieldId?: unknown;
        readonly fieldIds: unknown;
        readonly conditions: unknown;
        readonly paging: unknown;
        readonly order: unknown;
        readonly reason: string;
      };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_record_revision_conflict";
      readonly param: { readonly recordId: string };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_evidence_storage_mode_conflict";
      readonly param: { readonly sourceType: string; readonly sourceId: string | number };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_record_referenced";
      readonly param: {
        readonly recordId: string;
        readonly references: readonly {
          readonly tableId: string;
          readonly recordId: string;
          readonly fieldId: string;
        }[];
      };
      readonly humanMsg: string;
    }
  | {
      readonly type:
        | "memory_record_field_value_invalid"
        | "memory_record_reference_invalid"
        | "memory_record_required_field_missing"
        | "memory_record_unknown_field";
      readonly param: { readonly fieldId: string };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_record_field_value_too_long";
      readonly param: {
        readonly fieldId: string;
        readonly maxChars: number;
        readonly actualLength: number;
      };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_record_field_value_pattern_mismatch";
      readonly param: { readonly fieldId: string };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_backup_invalid_json";
      readonly param: { readonly reason: string };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_backup_format_invalid";
      readonly param: { readonly reason: string };
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_backup_version_unsupported";
      readonly param: { readonly version: unknown };
      readonly humanMsg: string;
    };

export type DomainErrorType = DomainErrorData["type"];

export class DomainError extends Error {
  readonly type: DomainErrorType;
  readonly param?: unknown;
  readonly humanMsg: string;

  constructor(data: DomainErrorData) {
    super(data.humanMsg);
    this.name = "DomainError";
    this.type = data.type;
    this.param = "param" in data ? data.param : undefined;
    this.humanMsg = data.humanMsg;
  }
}
