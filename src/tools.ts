import type { Artifact, Dataset, QueryResult, QuerySpec, ToolCall } from "./types";
import type { ToolSchema } from "./openrouter";
import { queryDataset, pageDataset } from "./datasets";

const PAGE_SIZE = 100;
const ARTIFACT_ROW_CAP = 100_000;
const ARTIFACT_BYTE_CAP = 1024 * 1024;

interface ToolEnv {
  dataset: Dataset;
  artifacts: Artifact[];
}

export function buildToolSchemas(dataset: Dataset): ToolSchema[] {
  const collections = dataset.collections.map((c) => c.name);
  const fieldsText = dataset.collections
    .map((c) => `${c.name} [{rowCount:${c.rowCount}}]: ${c.fields.map((f) => `${f.name}(${f.type})`).join(", ")}`)
    .join(" | ");

  const stringEnum = { type: "string", enum: collections } as const;

  return [
    {
      type: "function",
      function: {
        name: "inspect",
        description: `Inspect the datasets you own. Returns row counts, field schemas, and sample rows. Available datasets: ${fieldsText}`,
        parameters: {
          type: "object",
          properties: { collection: stringEnum },
          required: ["collection"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query",
        description:
          "Query one of your datasets. Returns a page of rows (max 100), the total count matching the filter, and a pagination cursor. Filter clauses are ANDed.",
        parameters: {
          type: "object",
          properties: {
            collection: stringEnum,
            filter: {
              type: "array",
              description: "List of filter clauses applied to matching rows.",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", description: "Field name from the dataset schema." },
                  op: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte", "contains"] },
                  value: { type: ["string", "number", "boolean"], description: "Value to match or compare against." },
                },
                required: ["field", "op", "value"],
                additionalProperties: false,
              },
            },
            fields: { type: "array", items: { type: "string" }, description: "Optional subset of fields to return." },
            sort: {
              type: "object",
              properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } },
              required: ["field", "dir"],
              additionalProperties: false,
            },
            limit: { type: "number", description: "Max rows to return; capped at 100." },
            groupBy: {
              type: "object",
              description: "Aggregate rows into groups.",
              properties: {
                by: { type: "string", description: "Field to group by." },
                agg: { type: "string", enum: ["sum", "count"] },
                field: { type: "string", description: "Numeric field to sum (required when agg is sum)." },
              },
              required: ["by", "agg"],
              additionalProperties: false,
            },
          },
          required: ["collection"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "page",
        description: "Fetch the next page of a previous query using its cursor.",
        parameters: {
          type: "object",
          properties: {
            cursor: { type: "string", description: "Cursor string returned by a previous query call." },
          },
          required: ["cursor"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "deliver",
        description:
          "Deliver a dataset artifact to the requester as a downloadable file. Use this for large payloads instead of printing rows in chat. Returns a confirmation.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short artifact name, e.g. '2025_totals.jsonl'." },
            format: { type: "string", enum: ["csv", "jsonl", "json"], description: "Serialization format." },
            rows: { type: "array", description: "Rows to include in the artifact." },
          },
          required: ["name", "format", "rows"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function clampInt(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.floor(n), max));
}

export async function executeTool(env: ToolEnv, call: ToolCall): Promise<{ summary: string; artifact?: Artifact }> {
  const dataset = env.dataset;
  switch (call.name) {
    case "inspect": {
      const collection = String(call.arguments.collection ?? "");
      const col = dataset.collections.find((c) => c.name === collection);
      if (!col) return { summary: `Unknown collection '${collection}'. Available: ${dataset.collections.map((c) => c.name).join(", ")}` };
      const sample = [];
      const n = Math.min(col.rowCount, 3);
      for (let i = 0; i < n; i++) sample.push(dataset.rows(collection, i));
      return {
        summary: JSON.stringify({
          collection,
          rowCount: col.rowCount,
          fields: col.fields,
          sample,
        }),
      };
    }
    case "query": {
      const spec: QuerySpec = {
        collection: String(call.arguments.collection ?? ""),
        filter: Array.isArray(call.arguments.filter) ? (call.arguments.filter as QuerySpec["filter"]) : [],
        fields: Array.isArray(call.arguments.fields) ? (call.arguments.fields as string[]) : undefined,
        sort: call.arguments.sort as QuerySpec["sort"],
        limit: clampInt(call.arguments.limit, PAGE_SIZE, PAGE_SIZE),
        groupBy: call.arguments.groupBy as QuerySpec["groupBy"],
      };
      const out = queryDataset(dataset, spec, PAGE_SIZE);
      return { summary: JSON.stringify(out) };
    }
    case "page": {
      const cursor = String(call.arguments.cursor ?? "");
      const out: QueryResult = pageDataset(dataset, cursor, PAGE_SIZE);
      return { summary: JSON.stringify(out) };
    }
    case "deliver": {
      const name = String(call.arguments.name ?? "artifact");
      const format = String(call.arguments.format ?? "json");
      const rows = Array.isArray(call.arguments.rows) ? call.arguments.rows : [];
      let text = "";
      if (format === "csv") {
        const header = Object.keys(rows[0] ?? {}).join(",");
        const body = rows
          .slice(0, ARTIFACT_ROW_CAP)
          .map((r) =>
            Object.values(r)
              .map((v) => String(v).replaceAll(",", "\\,").replaceAll("\n", " "))
              .join(","),
          )
          .join("\n");
        text = header + "\n" + body;
      } else if (format === "jsonl") {
        text = rows.slice(0, ARTIFACT_ROW_CAP).map((r) => JSON.stringify(r)).join("\n");
      } else {
        text = JSON.stringify(rows.slice(0, ARTIFACT_ROW_CAP));
      }
      const truncated = rows.length > ARTIFACT_ROW_CAP;
      const byteLength = new TextEncoder().encode(text).byteLength;
      const capped = byteLength > ARTIFACT_BYTE_CAP ? text.slice(0, ARTIFACT_BYTE_CAP) : text;
      const artifact: Artifact = {
        id: `art-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name,
        format: format as Artifact["format"],
        text: capped,
        byteLength,
      };
      env.artifacts.push(artifact);
      return {
        summary: JSON.stringify({
          name,
          format,
          rowCount: rows.length,
          truncated: truncated || capped.length < byteLength,
          byteLength,
        }),
        artifact,
      };
    }
    default:
      return { summary: `Unknown tool '${call.name}'` };
  }
}