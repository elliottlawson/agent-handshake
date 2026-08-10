export type FieldType = "string" | "number" | "int" | "date" | "string[]";

export interface Field {
  name: string;
  type: FieldType;
  description: string;
}

export interface Collection {
  name: string;
  fields: Field[];
  rowCount: number;
}

export interface Dataset {
  name: string;
  description: string;
  seed: string;
  collections: Collection[];
  rowCount(collection: string): number;
  rows(collection: string, index: number): Record<string, unknown>;
  tick?: () => void;
  tickLabel?: string;
}

export type FilterOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains";

export interface FilterClause {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface QuerySpec {
  collection: string;
  filter?: FilterClause[];
  fields?: string[];
  sort?: { field: string; dir: "asc" | "desc" };
  limit?: number;
  groupBy?: { by: string; agg: "sum" | "count"; field?: string };
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  totalCount: number;
  cursor: string | null;
  truncated?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  name: string;
  format: "csv" | "jsonl" | "json";
  text: string;
  byteLength: number;
}

export interface RunEstimate {
  budget: number;
}

export type TranscriptEntry =
  | { kind: "message"; side: "A" | "B"; text: string; partial?: boolean }
  | { kind: "tool-call"; side: "B"; tool: string; args: Record<string, unknown> }
  | { kind: "tool-result"; side: "B"; tool: string; summary: string }
  | { kind: "artifact"; side: "B"; artifact: Artifact }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

export interface ModelInfo {
  id: string;
  name: string;
}

export interface TestRunSettings {
  scenario: string;
  modelA: string;
  modelB: string;
  promptA: string;
  promptB: string;
  temperature: number;
  seed: string;
  timestamp: string;
  budgetUsed: number;
  transcript: TranscriptEntry[];
}