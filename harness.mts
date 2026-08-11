import { AgentRun, MAX_TURNS } from "./src/agent";
import { SCENARIOS, getScenario } from "./src/scenarios";
import type { TranscriptEntry } from "./src/types";

// Headless CLI harness for agent-handshake.
// Runs the real two-agent loop against OpenRouter and streams the transcript
// to the terminal live, then prints a scorecard per scenario.
//
// Usage:
//   npx tsx harness.mts --key $OPENROUTER_KEY
//   npx tsx harness.mts --key $KEY --scenario one-job,catalog-filter
//   npx tsx harness.mts --key $KEY --model-a deepseek/deepseek-v4-flash --model-b deepseek/deepseek-v4-flash
//   npx tsx harness.mts --key $KEY --turns 60

const args = process.argv.slice(2);
const get = (flag: string, def = ""): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? def : def;
};

const KEY = process.env.OPENROUTER_KEY ?? get("--key") ?? args[0] ?? "";
const SCENARIO_FILTER = (get("--scenario") || "all").split(",").filter(Boolean);
const MODEL_A = get("--model-a", "deepseek/deepseek-v4-flash");
const MODEL_B = get("--model-b", "deepseek/deepseek-v4-flash");
const CUSTOM_TURNS = Number(get("--turns", "") || "0");

if (!KEY || !KEY.startsWith("sk-")) {
  console.error("Provide an OpenRouter key: npx tsx harness.mts --key sk-...  (or $OPENROUTER_KEY)");
  process.exit(1);
}

const BUDGET = CUSTOM_TURNS > 0 ? CUSTOM_TURNS : MAX_TURNS;

// ---- live terminal rendering ----------------------------------------------
type Modes = "dim" | "caret" | "tool" | "result" | "artifact" | "warn" | "err" | "bold" | "ok" | "muted";
const C: Record<Modes, string> = {
  dim: "\x1b[2m",
  caret: "\x1b[36m",
  tool: "\x1b[34m",
  result: "\x1b[90m",
  artifact: "\x1b[32m",
  warn: "\x1b[33m",
  err: "\x1b[31m",
  bold: "\x1b[1m",
  ok: "\x1b[32;1m",
  muted: "\x1b[90m",
};
const c = (mode: Modes, s: string): string => `${C[mode]}${s}\x1b[0m`;

let streamed = 0;
function render(entry: TranscriptEntry): void {
  switch (entry.kind) {
    case "message": {
      const prefix = entry.side === "A" ? c("caret", "A >") : c("dim", "B >");
      if (entry.partial) {
        process.stdout.write(`\r${prefix} ${entry.text}`);
      } else {
        process.stdout.write(streamed === 0 ? `\n${prefix} ${entry.text}` : `\n${prefix} ${entry.text}`);
      }
      break;
    }
    case "tool-call":
      process.stdout.write(
        `\n  ${c("tool", "🔧 " + entry.tool)} ${c("muted", JSON.stringify(entry.args))}`,
      );
      break;
    case "tool-result": {
      const trimmed = entry.summary.length > 160 ? entry.summary.slice(0, 160) + "…" : entry.summary;
      const ok = !trimmed.startsWith("Unknown tool") && !trimmed.startsWith("Unknown collection");
      process.stdout.write(`\n  ${c(ok ? "muted" : "err", "↩ " + trimmed)}`);
      if (!ok) process.stdout.write(c("warn", "  ⚠ FAILED TOOL CALL"));
      break;
    }
    case "artifact":
      process.stdout.write(`\n  ${c("artifact", "⬇ artifact " + entry.artifact.name + " (" + entry.artifact.byteLength + "b)")}`);
      break;
    case "note":
      process.stdout.write(`\n  ${c("muted", "· " + entry.text)}`);
      break;
    case "error":
      process.stdout.write(`\n  ${c("err", "⚠ " + entry.text)}`);
      break;
  }
  streamed += 1;
}

// ---- scoring ---------------------------------------------------------------
interface Score {
  scenario: string;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  artifacts: number;
  delivered: boolean;
  hitTruncation: boolean;
  sawInspect: boolean;
  sawQuery: boolean;
  sawDeliver: boolean;
  reason: string;
  transcript: TranscriptEntry[];
}

function score(scenarioName: string, transcript: TranscriptEntry[], turns: number, reason: string): Score {
  const toolCalls = transcript.filter((e) => e.kind === "tool-call");
  const failures = transcript.filter((e) => e.kind === "tool-result" && e.summary.startsWith("Unknown tool"));
  const artifacts = transcript.filter((e) => e.kind === "artifact");
  return {
    scenario: scenarioName,
    turns,
    toolCalls: toolCalls.length,
    toolFailures: failures.length,
    artifacts: artifacts.length,
    delivered: artifacts.length > 0,
    hitTruncation: reason.startsWith("max turns"),
    sawInspect: toolCalls.some((t) => (t as Extract<TranscriptEntry, { kind: "tool-call" }>).tool === "inspect"),
    sawQuery: toolCalls.some((t) => (t as Extract<TranscriptEntry, { kind: "tool-call" }>).tool === "query"),
    sawDeliver: toolCalls.some((t) => (t as Extract<TranscriptEntry, { kind: "tool-call" }>).tool === "deliver"),
    reason,
    transcript: [...transcript],
  };
}

function runScenario(sc: (typeof SCENARIOS)[number]): Promise<Score> {
  return new Promise((resolve) => {
    const transcript: TranscriptEntry[] = [];
    console.log(`\n${c("bold", "═══ " + sc.name + " ═══")}   ${c("muted", sc.blurb)}`);
    console.log(c("muted", `models: A=${MODEL_A}  B=${MODEL_B}  budget=${BUDGET} turns`));

    const run = new AgentRun({
      apiKey: KEY,
      modelA: MODEL_A,
      modelB: MODEL_B,
      promptA: sc.defaultPromptA,
      promptB: sc.defaultPromptB,
      temperature: 0,
      dataset: sc.dataset,
      onTranscript: (entry) => {
        transcript.push(entry);
        render(entry);
      },
      onStatus: (s) => {
        if (!["running", "idle"].includes(s)) process.stdout.write(`\n${c("muted", `[${s}]`)}`);
      },
      onDone: (reason) => resolve(score(sc.name, transcript, run.getTurnCount(), reason)),
    });
    run.start();
  });
}

// ---- main -------------------------------------------------------------------
const targets = SCENARIO_FILTER[0] === "all" ? SCENARIOS : SCENARIO_FILTER.map(getScenario).filter(Boolean);
console.log(c("muted", `agent-handshake harness — ${targets.length} scenario(s), ${KEY.slice(0, 6)}…`));

const results: Score[] = [];
for (const sc of targets) {
  const r = await runScenario(sc);
  results.push(r);
}

console.log("\n\n" + c("bold", "═══════════════ SUMMARY ═══════════════"));
const pad = (s: string, n: number): string => s.padEnd(n);
console.log(
  pad("SCENARIO", 22) +
    pad("turns", 7) +
    pad("tools", 7) +
    pad("fail", 6) +
    pad("artfct", 8) +
    "deliver?  notes",
);
for (const r of results) {
  const ok = r.delivered && r.toolFailures === 0;
  console.log(
    pad(r.scenario, 22) +
      pad(String(r.turns), 7) +
      pad(String(r.toolCalls), 7) +
      pad(String(r.toolFailures), 6) +
      pad(String(r.artifacts), 8) +
      (r.delivered ? c("ok", "YES      ") : c("err", "no       ")) +
      (ok ? c("muted", "clean") : r.hitTruncation ? c("warn", "hit turn cap") : r.toolFailures > 0 ? c("warn", `${r.toolFailures} tool failures`) : ""),
  );
}
const delivered = results.filter((r) => r.delivered).length;
console.log(`\n${c("bold", `${delivered}/${results.length} scenarios delivered an artifact`)}`);

// export full transcripts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const outDir = resolve(process.cwd(), "harness-output");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
for (const r of results) {
  const file = resolve(outDir, `${r.scenario.replace(/\s+/g, "-")}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ modelA: MODEL_A, modelB: MODEL_B, ...r }, null, 2));
  console.log(c("muted", `  wrote ${file}`));
}
console.log(c("muted", `\nfull transcripts saved to ${outDir}/`));
