import { AgentRun } from "./src/agent";
import { generateDataset } from "./src/datasets";
import type { ChatMessage, StreamDelta } from "./src/openrouter";

const dataset = generateDataset("products", "catalog-v1");
const transcript: string[] = [];

type MockOpts = {
  messages: ChatMessage[];
  model: string;
  apiKey: string;
  temperature: number;
  tools?: unknown[];
  signal?: AbortSignal;
};

// Mock B's decision: based on negotiation state (last message role), emit the next move.
// State machine: (first user) -> inspect -> (tool result) query -> (tool result) deliver -> confirm -> final answer
let delivered = false;
let confirmed = false;
const mockStream = async (opts: MockOpts, onDelta: (d: StreamDelta) => void) => {
  if (opts.model === "mock/A") {
    const text = delivered
      ? "Please confirm you really delivered all rows from the catalog query."
      : "I need every active kitchen product under $40 with stock > 0: sku, name, price_cents, stock.";
    for (let i = 0; i < text.length; i += 6) {
      onDelta({ content: text.slice(i, i + 6), toolCalls: new Map(), done: false });
    }
    onDelta({ content: "", toolCalls: new Map(), done: true });
    return;
  }

  // "mock/B"
  let name = "";
  let args: Record<string, unknown> = {};
  if (delivered && !confirmed) {
    confirmed = true;
    const answer = "\nConfirmed: the CSV artifact kitchen_under40.csv contains every active kitchen product priced under $40 with stock > 0.";
    onDelta({ content: answer, toolCalls: new Map(), done: false });
    onDelta({ content: "", toolCalls: new Map(), done: true });
    return;
  }
  if (delivered && confirmed) {
    // stop emitting tools for the rest of the run; just say it again briefly
    onDelta({ content: "Nothing further.", toolCalls: new Map(), done: false });
    onDelta({ content: "", toolCalls: new Map(), done: true });
    return;
  }
  const toolResultCount = opts.messages.filter((m) => m.role === "tool").length;
  if (toolResultCount > 0) {
    if (toolResultCount === 1) {
      // just inspected; now query
      name = "query";
      args = {
        collection: "products",
        filter: [
          { field: "category", op: "eq", value: "kitchen" },
          { field: "price_cents", op: "lt", value: 4000 },
          { field: "stock", op: "gt", value: 0 },
        ],
        fields: ["sku", "name", "price_cents", "stock"],
        limit: 100,
      };
    } else {
      // queried; deliver the rows from the catalog query
      name = "deliver";
      delivered = true;
      args = { name: "kitchen_under40.csv", format: "csv", rows: [{ sku: "SKU-1", name: "Blender", price_cents: 2999, stock: 4 }] };
    }
  } else {
    name = "inspect";
    args = { collection: "products" };
  }

  const id = `call_${name}`;
  onDelta({ content: "", toolCalls: new Map([[id, { id, name, args: JSON.stringify(args) }]]), done: false });
  onDelta({ content: "", toolCalls: new Map(), done: true });
};

const run = new AgentRun({
  apiKey: "mock",
  modelA: "mock/A",
  modelB: "mock/B",
  promptA: "You are A.",
  promptB: "You are B. You own the products dataset.",
  temperature: 0,
  dataset,
  chat: mockStream as never,
  onTranscript: (e) => {
    if (e.kind === "tool-call") transcript.push(`TOOL ${e.tool}`);
    if (e.kind === "artifact") transcript.push(`ARTIFACT ${e.artifact.name}`);
    if (e.kind === "message" && e.side === "A") transcript.push("A:" + e.text.slice(0, 24));
  },
  onStatus: () => undefined,
  onDone: (reason) => transcript.push("DONE " + reason),
});

run.start();
// wait for the run to naturally hit max turns (mock always makes progress)
await new Promise((r) => setTimeout(r, 500));
console.log(transcript.join("\n"));
console.log("turns used:", run.getTurnCount());

const sawInspect = transcript.some((t) => t === "TOOL inspect");
const sawQuery = transcript.some((t) => t === "TOOL query");
const sawDeliver = transcript.some((t) => t === "TOOL deliver");
const sawArtifact = transcript.some((t) => t.startsWith("ARTIFACT"));
const passed = sawInspect && sawQuery && sawDeliver && sawArtifact;
console.log(passed ? "LOOP TEST PASS" : "LOOP TEST FAIL");
process.exit(passed ? 0 : 1);