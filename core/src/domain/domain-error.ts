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
