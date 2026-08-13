import { streamText, tool, jsonSchema, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelInfo } from "./types";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const APP_REFERRER = "https://elliottlawson.github.io/agent-handshake";
export const APP_TITLE = "agent-handshake";

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to load models (HTTP ${res.status})`);
  const data = (await res.json()) as {
    data?: {
      id: string;
      name?: string;
      supported_parameters?: string[] | { tools?: boolean };
    }[];
  };
  const toolCapable = (m: { supported_parameters?: string[] | { tools?: boolean } }): boolean => {
    const sp = m.supported_parameters;
    if (Array.isArray(sp)) return sp.includes("tools");
    return sp?.tools === true;
  };
  return (data.data ?? [])
    .filter(toolCapable)
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export interface StreamCallOpts {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  apiKey: string;
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface StreamDelta {
  content: string;
  toolCalls: Map<string, { id: string; name: string; args: string }>;
  done: boolean;
}

function toModelMessages(msgs: ChatMessage[]): ModelMessage[] {
  return msgs.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id!,
            toolName: "",
            output: { type: "text", value: m.content ?? "" },
          },
        ],
      };
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: [
          { type: "text", text: m.content ?? "" },
          ...m.tool_calls.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          })),
        ],
      };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}

export async function streamChat(opts: StreamCallOpts, onDelta: (d: StreamDelta) => void): Promise<void> {
  const openrouter = createOpenAI({
    baseURL: `${OPENROUTER_BASE}/v1`,
    apiKey: opts.apiKey,
    headers: {
      "HTTP-Referer": APP_REFERRER,
      "X-OpenRouter-Title": APP_TITLE,
    },
  });

  const result = streamText({
    model: openrouter.chat(opts.model),
    messages: toModelMessages(opts.messages),
    temperature: opts.temperature,
    ...(opts.tools && opts.tools.length > 0
      ? {
          tools: Object.fromEntries(
            opts.tools.map((s) => [
              s.function.name,
              tool({
                description: s.function.description,
                inputSchema: jsonSchema(s.function.parameters),
              }),
            ]),
          ),
        }
      : {}),
    abortSignal: opts.signal,
  });

  const toolCalls = new Map<string, { id: string; name: string; args: string }>();
  let content = "";

  for await (const event of result.fullStream) {
    switch (event.type) {
      case "text-delta":
        content += event.text;
        onDelta({ content: event.text, toolCalls: new Map(toolCalls), done: false });
        break;
      case "tool-call":
        toolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: JSON.stringify(event.input),
        });
        onDelta({ content: "", toolCalls: new Map(toolCalls), done: false });
        break;
      case "finish":
        onDelta({ content: "", toolCalls: new Map(toolCalls), done: true });
        break;
      case "error":
        throw event.error;
    }
  }
}