export interface MemorySpacesTable {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryTablesTable {
  id: string;
  memory_space_id: string;
  key: string;
  kind: MemoryTableKind;
  name: string;
  description: string;
  prompt: string;
  enabled: number;
  display_strategy: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryFieldsTable {
  id: string;
  memory_space_id: string;
  table_id: string;
  key: string;
  name: string;
  type: MemoryFieldType;
  required: number;
  prompt: string;
  enabled: number;
  position: number;
  options_json: string;
  reference_table_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryRecordsTable {
  id: string;
  memory_space_id: string;
  table_id: string;
  payload_json: string;
  field_evidence_json: string;
  display_text: string;
  source_json: string;
  revision_id: string;
  revision_source: MemoryRevisionSource;
  created_at: string;
  updated_at: string;
}

export interface MemoryRecordHistoryTable {
  id: string;
  record_id: string;
  memory_space_id: string;
  table_id: string;
  payload_json: string;
  field_evidence_json: string;
  display_text: string;
  source_json: string;
  previous_revision_id: string;
  previous_revision_source: MemoryRevisionSource;
  revision_id: string;
  revision_source: MemoryRevisionSource;
  created_at: string;
  updated_at: string;
  archived_at: string;
}

export interface MemoryEvidenceTable {
  memory_space_id: string;
  evidence_id: string;
  source_type: string;
  source_id_json: string;
  storage_mode: "snapshot" | "reference";
  content: string | null;
  extra_props_json: string;
}

export interface SourceStoreChatsTable {
  memory_space_id: string;
  source_type: "sillytavern_jsonl";
  metadata_json: string;
  created_at: string;
}

export interface SourceStoreMessagesTable {
  memory_space_id: string;
  source_id: number;
  content: string;
  extra_props_json: string;
  status: "untracked" | "processed" | "error";
}

export interface MemoryFillTasksTable {
  run_id: string;
  memory_space_id: string;
  from_source_id: number;
  to_source_id: number;
  block_size: number;
  status:
    | "queued"
    | "running"
    | "pause_requested"
    | "paused"
    | "cancel_requested"
    | "cancelled"
    | "succeeded"
    | "failed"
    | "interrupted";
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceStoreParseErrorsTable {
  memory_space_id: string;
  line_number: number;
  raw_line: string;
  message: string;
}

export interface CleaningRulesTable {
  id: string;
  memory_space_id: string;
  position: number;
  enabled: number;
  name: string;
  mode: "keep" | "discard";
  pattern: string;
  flags: string;
  created_at: string;
  updated_at: string;
}

export interface DatabaseSchema {
  memory_spaces: MemorySpacesTable;
  memory_tables: MemoryTablesTable;
  memory_fields: MemoryFieldsTable;
  memory_records: MemoryRecordsTable;
  memory_record_history: MemoryRecordHistoryTable;
  memory_evidence: MemoryEvidenceTable;
  source_store_chats: SourceStoreChatsTable;
  source_store_messages: SourceStoreMessagesTable;
  source_store_parse_errors: SourceStoreParseErrorsTable;
  memory_fill_tasks: MemoryFillTasksTable;
  cleaning_rules: CleaningRulesTable;
}
import type {
  MemoryFieldType,
  MemoryRevisionSource,
  MemoryTableKind,
} from "@ste-memory/core/memory";
