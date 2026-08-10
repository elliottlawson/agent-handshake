import type { Artifact, Dataset, ToolCall, TranscriptEntry } from "./types";
import type { ChatMessage, StreamDelta, ToolSchema } from "./openrouter";
import { streamChat } from "./openrouter";
import { buildToolSchemas, executeTool } from "./tools";

export const MAX_TURNS = 48;
export const MAX_EXTRA_TOOL_CALLS = 10;

export interface RunConfig {
  apiKey: string;
  modelA: string;
  modelB: string;
  promptA: string;
  promptB: string;
  temperature: number;
  dataset: Dataset;
  onTranscript: (entry: TranscriptEntry) => void;
  onStatus: (status: string) => void;
  onDone: (reason: string) => void;
  /** Test seam: replace the OpenRouter transport. */
  chat?: typeof streamChat;
}

type LoopState = "idle" | "running" | "paused" | "finished";

interface BReply {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
}

export class AgentRun {
  private config: RunConfig;
  private history: ChatMessage[] = [];
  private entries: TranscriptEntry[] = [];
  private abort: AbortController | null = null;
  private state: LoopState = "idle";
  private turnCount = 0;
  private cancelled = false;
  private pauseRequested = false;

  constructor(config: RunConfig) {
    this.config = config;
  }

  getState(): LoopState {
    return this.state;
  }

  getTranscript(): TranscriptEntry[] {
    return this.entries;
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  start(): void {
    if (this.state === "running") return;
    this.state = "running";
    this.pauseRequested = false;
    this.cancelled = false;
    this.config.onStatus("running");
    void this.run();
  }

  pause(): void {
    if (this.state === "running") this.pauseRequested = true;
  }

  step(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.config.onStatus("running");
    void this.run();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.pauseRequested = false;
    this.state = "running";
    this.config.onStatus("running");
    void this.run();
  }

  stop(): void {
    this.cancelled = true;
    if (this.abort) this.abort.abort();
    if (this.state === "running") {
      this.state = "finished";
      this.config.onStatus("stopped");
      this.config.onDone("stopped by user");
    }
  }

  private async run(): Promise<void> {
    try {
      while (this.state === "running" && !this.cancelled) {
        if (this.turnCount >= MAX_TURNS) {
          this.finish(`max turns reached (${MAX_TURNS})`);
          return;
        }
        this.turnCount += 1;
        await this.aSpeak();
        await this.checkpointPromise();
        if (this.state !== "running" || this.cancelled) return;

        await this.bSpeak();
        await this.checkpointPromise();
        if (this.state !== "running" || this.cancelled) return;
      }
    } catch (e) {
      if (this.cancelled) return;
      const msg = e instanceof Error ? e.message : String(e);
      const entry: TranscriptEntry = { kind: "error", text: msg };
      this.entries.push(entry);
      this.config.onTranscript(entry);
      this.finish("error");
    }
  }

  private checkpointPromise(): Promise<void> {
    if (this.pauseRequested && this.state === "running") {
      this.pauseRequested = false;
      this.state = "paused";
      this.config.onStatus("paused");
    }
    return Promise.resolve();
  }

  private finish(reason: string): void {
    this.state = "finished";
    this.config.onStatus(reason);
    this.config.onDone(reason);
  }

  private async aSpeak(): Promise<void> {
    const entry: Extract<TranscriptEntry, { kind: "message" }> = { kind: "message", side: "A", text: "", partial: true };
    this.entries.push(entry);
    this.config.onTranscript(entry);

    const abort = new AbortController();
    this.abort = abort;

    const self = this;
    const transport = this.config.chat ?? streamChat;
    await transport(
      {
        model: this.config.modelA,
        messages: [{ role: "system", content: this.config.promptA }, ...this.history],
        temperature: this.config.temperature,
        apiKey: this.config.apiKey,
        signal: abort.signal,
      },
      (d: StreamDelta) => {
        entry.text += d.content;
        entry.partial = !d.done;
        self.config.onTranscript(entry);
      },
    );

    entry.partial = false;
    this.history.push({ role: "assistant", content: entry.text });
    this.config.onTranscript(entry);
  }

  private async bSpeak(): Promise<void> {
    const tools = buildToolSchemas(this.config.dataset);
    const env = { dataset: this.config.dataset, artifacts: [] as Artifact[] };

    const entry: Extract<TranscriptEntry, { kind: "message" }> = { kind: "message", side: "B", text: "", partial: true };
    this.entries.push(entry);
    this.config.onTranscript(entry);

    let reply = await this.bStream(entry, tools);
    let toolCalls = reply.toolCalls;
    let usedTools = 0;

    while (toolCalls.length > 0 && usedTools < MAX_EXTRA_TOOL_CALLS && this.state === "running" && !this.cancelled) {
      for (const tc of toolCalls) {
        if (this.cancelled) break;
        usedTools += 1;
        await this.executeOne(env, tc);
      }
      if (usedTools >= MAX_EXTRA_TOOL_CALLS || this.cancelled) break;

      reply = await this.bStream(entry, tools);
      toolCalls = reply.toolCalls;
    }

    if (usedTools >= MAX_EXTRA_TOOL_CALLS && toolCalls.length > 0) {
      const err: TranscriptEntry = { kind: "error", text: `tool call limit reached (${MAX_EXTRA_TOOL_CALLS}) for a single B reply cycle` };
      this.entries.push(err);
      this.config.onTranscript(err);
    }

    entry.partial = false;
    entry.text = entry.text.trimEnd();
    this.config.onTranscript(entry);
  }

  private async bStream(
    entry: Extract<TranscriptEntry, { kind: "message" }>,
    tools: ToolSchema[],
  ): Promise<BReply> {
    const toolCalls = new Map<string, { id: string; name: string; args: string }>();

    const abort = new AbortController();
    this.abort = abort;
    const self = this;

    await (this.config.chat ?? streamChat)(
      {
        model: this.config.modelB,
        messages: [{ role: "system", content: this.config.promptB }, ...this.history],
        temperature: this.config.temperature,
        apiKey: this.config.apiKey,
        tools,
        signal: abort.signal,
      },
      (d: StreamDelta) => {
        if (d.content) {
          entry.text += d.content;
          entry.partial = !d.done;
          self.config.onTranscript(entry);
        }
        for (const tc of d.toolCalls.values()) {
          const existing = toolCalls.get(tc.id) ?? { id: tc.id, name: "", args: "" };
          if (tc.name) existing.name += tc.name;
          if (tc.args) existing.args += tc.args;
          toolCalls.set(tc.id, existing);
        }
        entry.partial = !d.done;
        self.config.onTranscript(entry);
      },
    );

    const final: BReply = { text: entry.text, toolCalls: [] };
    const seen = new Set<string>();
    for (const tc of toolCalls.values()) {
      if (tc.name) {
        final.toolCalls.push(tc);
        seen.add(tc.id);
      }
    }
    if (seen.size > 0) {
      this.history.push({
        role: "assistant",
        content: final.text || null,
        tool_calls: [...seen].map((id) => ({ id, type: "function" as const, function: { name: "", arguments: "" } })),
      });
    } else {
      this.history.push({ role: "assistant", content: final.text });
    }
    return final;
  }

  private async executeOne(env: { dataset: Dataset; artifacts: Artifact[] }, tcc: { id: string; name: string; args: string }): Promise<void> {
    const call: ToolCall = { id: tcc.id, name: tcc.name, arguments: safeJsonParse(tcc.args) as Record<string, unknown> };
    this.entries.push({ kind: "tool-call", side: "B", tool: tcc.name, args: call.arguments });
    this.config.onTranscript({ kind: "tool-call", side: "B", tool: tcc.name, args: call.arguments });

    const result = await executeTool(env, call);
    this.entries.push({ kind: "tool-result", side: "B", tool: tcc.name, summary: result.summary });
    this.config.onTranscript({ kind: "tool-result", side: "B", tool: tcc.name, summary: result.summary });
    if (result.artifact) {
      this.entries.push({ kind: "artifact", side: "B", artifact: result.artifact });
      this.config.onTranscript({ kind: "artifact", side: "B", artifact: result.artifact });
    }
    this.history.push({ role: "tool", tool_call_id: tcc.id, content: result.summary });
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}