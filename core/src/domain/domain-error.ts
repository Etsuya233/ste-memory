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
      readonly type: "memory_table_name_required";
      readonly humanMsg: string;
    }
  | {
      readonly type: "memory_table_name_too_long";
      readonly param: { readonly maxLength: number };
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
        | "memory_record_paging_invalid"
        | "memory_record_source_invalid";
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
