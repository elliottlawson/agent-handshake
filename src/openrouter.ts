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

/**
 * Stream one chat completion from OpenRouter. Yields deltas; throws on HTTP/API error.
 */
export async function streamChat(opts: StreamCallOpts, onDelta: (d: StreamDelta) => void): Promise<void> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "HTTP-Referer": APP_REFERRER,
      "X-OpenRouter-Title": APP_TITLE,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j.error?.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`OpenRouter error (HTTP ${res.status}): ${detail}`);
  }

  if (!res.body) throw new Error("OpenRouter returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const toolCalls = new Map<string, { id: string; name: string; args: string }>();
  let content = "";
  let sawDone = false;

  const feed = (d: StreamDelta) => onDelta(d);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        break;
      }
      let json: {
        choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        feed({ content: delta.content, toolCalls: new Map(toolCalls), done: false });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const existing = toolCalls.get(String(index)) ?? { id: tc.id ?? `call_${index}`, name: "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCalls.set(String(index), existing);
        }
        feed({ content: "", toolCalls: new Map(toolCalls), done: false });
      }
    }
    if (sawDone) break;
  }

  feed({ content: "", toolCalls: new Map(toolCalls), done: true });
}