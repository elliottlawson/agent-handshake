import { streamChat } from "./src/openrouter";

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  checks.push({ name, pass: !!cond, detail });
}

// Reproduce the DeepSeek/OpenRouter behavior: the tool name is resent on EVERY
// stream chunk (not just the first). The accumulation must NOT concatenate it.
const sseChunks: string[] = [
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "inspect", arguments: "" } }] } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "inspect", arguments: "" } }] } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "inspect", arguments: "" } }] } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"collection\":\"contractors\"}" } }] } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] })}`,
  "",
  "data: [DONE]",
  "",
];

const encoder = new TextEncoder();
function mkBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of sseChunks) controller.enqueue(encoder.encode(c + "\n"));
      controller.close();
    },
  });
}

// Patch global fetch
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  return {
    ok: true,
    status: 200,
    body: mkBody(),
    json: async () => ({}),
  } as unknown as Response;
}) as typeof fetch;

const seenTool: Record<string, string> = {};
await streamChat(
  { model: "deepseek/test", messages: [], temperature: 0, apiKey: "x" },
  (d) => {
    for (const tc of d.toolCalls.values()) {
      seenTool.id = tc.id;
      seenTool.name = tc.name;
      seenTool.args = tc.args;
    }
  },
);

globalThis.fetch = realFetch;

check("tool name is not concatenated on resend", seenTool.name === "inspect", `got '${seenTool.name}'`);
check("tool args accumulate correctly", seenTool.args === '{"collection":"contractors"}', `got '${seenTool.args}'`);
check("tool id preserved", seenTool.id === "call_1", `got '${seenTool.id}'`);

let pass = 0;
for (const c of checks) {
  console.log((c.pass ? "PASS" : "FAIL") + "  " + c.name + (c.pass ? "" : "  <-- " + c.detail));
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
