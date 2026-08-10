import type { ModelInfo, TranscriptEntry, TestRunSettings } from "./types";
import type { Scenario } from "./scenarios";
import { SCENARIOS, getScenario, renderDatasetInfo } from "./scenarios";
import { listModels } from "./openrouter";
import { AgentRun, MAX_TURNS } from "./agent";
import "./style.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(items: ModelInfo[], value: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.appendChild(el("option", "", "Loading models…"));
  for (const m of items) {
    const opt = el("option", "", m.name ?? m.id);
    opt.setAttribute("value", m.id);
    if (m.id === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

const KEY_STORAGE = "agent-handshake:openrouter-key";

export function mount(root: HTMLElement): void {
  root.innerHTML = "";

  // ---- state -------------------------------------------------------------
  let scenario: Scenario = getScenario(SCENARIOS[0].id);
  let modelA = "openai/gpt-4o";
  let modelB = "anthropic/claude-3-5-sonnet";
  let promptA = scenario.defaultPromptA;
  let promptB = scenario.defaultPromptB;
  let temperature = 0;
  let seed = scenario.defaultSeed;
  let apiKey = localStorage.getItem(KEY_STORAGE) ?? "";
  let run: AgentRun | null = null;
  let models: ModelInfo[] = [];
  let runLog: TestRunSettings[] = [];

  const statusText = el("span", "status-text", "idle");

  // ---- layout ------------------------------------------------------------
  const header = el("header", "header");
  header.appendChild(el("h1", "title", "agent-handshake"));
  header.appendChild(el("p", "tagline", "Simulate AI-to-AI interaction without a structured API."));

  const top = el("div", "topbar");
  const scenarioSel = el("select", "scenario-select");
  for (const s of SCENARIOS) {
    const opt = el("option", "", s.name);
    opt.setAttribute("value", s.id);
    scenarioSel.appendChild(opt);
  }
  const keyInput = el("input") as HTMLInputElement;
  keyInput.type = "password";
  keyInput.placeholder = "OpenRouter API key (stays in this browser)";
  keyInput.value = apiKey;
  keyInput.addEventListener("input", () => {
    apiKey = keyInput.value.trim();
    localStorage.setItem(KEY_STORAGE, apiKey);
  });

  const tempInput = el("input") as HTMLInputElement;
  tempInput.type = "number";
  tempInput.min = "0";
  tempInput.max = "1";
  tempInput.step = "0.1";
  tempInput.value = "0";
  tempInput.title = "Temperature (default 0 for determinism)";
  tempInput.addEventListener("input", () => {
    temperature = Number(tempInput.value) || 0;
  });

  const seedInput = el("input") as HTMLInputElement;
  seedInput.placeholder = "Seed";
  seedInput.value = seed;
  seedInput.title = "Data generation seed (re-run with the same seed = same data)";
  seedInput.addEventListener("input", () => {
    seed = seedInput.value.trim() || scenario.defaultSeed;
  });

  const refreshModelsBtn = el("button", "btn", "Refresh models");

  const btnRun = el("button", "btn primary", "Run");
  const btnPause = el("button", "btn", "Pause");
  const btnStep = el("button", "btn", "Step");
  const btnResume = el("button", "btn", "Resume");
  const btnStop = el("button", "btn danger", "Stop");
  const btnExport = el("button", "btn", "Export");
  const btnViewLog = el("button", "btn", "Run log");

  btnRun.addEventListener("click", () => {
    if (!apiKey) {
      setStatus("set an OpenRouter API key first");
      return;
    }
    if (!modelA || !modelB) {
      setStatus("pick a model for both sides (Refresh models if the list is empty)");
      return;
    }
    startRun();
  });
  btnPause.addEventListener("click", () => run?.pause());
  btnStep.addEventListener("click", () => run?.step());
  btnResume.addEventListener("click", () => run?.resume());
  btnStop.addEventListener("click", () => run?.stop());

  btnExport.addEventListener("click", () => {
    if (!run) {
      setStatus("nothing to export yet");
      return;
    }
    exportRun(scenario, modelA, modelB, promptA, promptB, temperature, seed, run);
  });

  btnViewLog.addEventListener("click", () => {
    const panel = document.getElementById("run-log-panel");
    if (panel) panel.hidden = !panel.hidden;
  });

  top.append(el("label", "lbl", "Scenario"), scenarioSel, el("label", "lbl", "Key"), keyInput, el("label", "lbl", "Temp"), tempInput, el("label", "lbl", "Seed"), seedInput, refreshModelsBtn, btnRun, btnPause, btnStep, btnResume, btnStop, btnExport, btnViewLog, statusText);

  // ---- run log ------------------------------------------------------------
  const runLogPanel = el("div", "run-log-panel");
  runLogPanel.id = "run-log-panel";
  runLogPanel.hidden = true;

  const three = el("div", "columns");

  // ---- LEFT: Requester ----------------------------------------------------
  const left = el("section", "column requester");
  left.appendChild(el("h2", "col-title", "Requester (A) — asks for data"));
  left.appendChild(el("p", "hint", "No tools. Asks the Source in natural language."));
  const modelASelect = select(models, modelA);
  modelASelect.addEventListener("change", () => {
    modelA = modelASelect.value;
  });
  const aModelWrap = el("label", "lbl", "Model");
  aModelWrap.appendChild(modelASelect);
  left.appendChild(aModelWrap);
  const aPrompt = el("textarea", "prompt-input");
  aPrompt.rows = 18;
  aPrompt.value = promptA;
  aPrompt.addEventListener("input", () => {
    promptA = aPrompt.value;
  });
  left.appendChild(aPrompt);

  // ---- MIDDLE: transcript --------------------------------------------------
  const mid = el("section", "column transcript");
  mid.appendChild(el("h2", "col-title", "Conversation"));
  const transcriptEl = el("div", "transcript");
  transcriptEl.dataset.testid = "transcript";
  mid.appendChild(transcriptEl);

  // ---- RIGHT: Source --------------------------------------------------------
  const right = el("section", "column source");
  right.appendChild(el("h2", "col-title", "Source (B) — owns the data"));
  right.appendChild(el("p", "hint", "Reads its dataset only through its tools."));
  const modelBSelect = select(models, modelB);
  modelBSelect.addEventListener("change", () => {
    modelB = modelBSelect.value;
  });
  const bModelWrap = el("label", "lbl", "Model");
  bModelWrap.appendChild(modelBSelect);
  right.appendChild(bModelWrap);

  const infoCard = el("div", "dataset-card");
  const infoTitle = el("h3", "", scenario.name + " dataset");
  const infoBody = el("pre", "dataset-info");
  right.appendChild(infoTitle);
  right.appendChild(infoCard);
  {
    const info = renderDatasetInfo(scenario.dataset);
    infoBody.textContent = info;
    infoCard.appendChild(el("p", "hint", `${scenario.blurb}`));
    infoCard.appendChild(infoBody);
  }

  const toolList = el("ul", "tool-list");
  for (const t of ["inspect", "query", "page", "deliver"]) {
    toolList.appendChild(el("li", "", t));
  }
  infoCard.appendChild(el("p", "hint", "Fixed toolkit, capped:"));
  infoCard.appendChild(toolList);

  const tickWrap = el("div", "tick-wrap");
  const btnTick = el("button", "btn", scenario.tickLabel ?? "Tick");
  btnTick.hidden = !scenario.tick;
  btnTick.addEventListener("click", () => {
    scenario.tick?.();
    infoBody.textContent = renderDatasetInfo(scenario.dataset);
    setStatus("ticked time forward — new events may now be available");
  });
  tickWrap.appendChild(btnTick);
  right.appendChild(tickWrap);

  const bPrompt = el("textarea", "prompt-input");
  bPrompt.rows = 18;
  bPrompt.value = promptB;
  bPrompt.addEventListener("input", () => {
    promptB = bPrompt.value;
  });
  right.appendChild(bPrompt);

  three.append(left, mid, right);

  // ---- footer ----------------------------------------------------------------
  const footer = el("footer", "footer");
  footer.appendChild(
    el(
      "p",
      "",
      "Your key is used only in this tab to call OpenRouter — it never leaves the browser. Source is open: github.com/elliottlawson/agent-handshake.",
    ),
  );

  root.append(header, top, runLogPanel, three, footer);

  // ---- behaviors -------------------------------------------------------------
  scenarioSel.addEventListener("change", () => {
    scenario = getScenario(scenarioSel.value);
    modelA = "";
    modelB = "";
    promptA = scenario.defaultPromptA;
    promptB = scenario.defaultPromptB;
    seed = scenario.defaultSeed;
    aPrompt.value = promptA;
    bPrompt.value = promptB;
    seedInput.value = seed;
    infoTitle.textContent = scenario.name + " dataset";
    infoBody.textContent = renderDatasetInfo(scenario.dataset);
    btnTick.hidden = !scenario.tick;
    btnTick.textContent = scenario.tickLabel ?? "Tick";
    setStatus("scenario changed");
    const h = modelASelect.querySelectorAll("option");
    h.forEach((o) => o.remove());
    modelASelect.appendChild(el("option", "", "Loading models…"));
    const h2 = modelBSelect.querySelectorAll("option");
    h2.forEach((o) => o.remove());
    modelBSelect.appendChild(el("option", "", "Loading models…"));
    loadModels();
  });

  refreshModelsBtn.addEventListener("click", loadModels);

  (async function init() {
    loadModels();
    renderPromptCard(transcriptEl, []);
  })();

  function loadModels() {
    if (!apiKey) {
      setStatus("enter an API key, then refresh models");
      return;
    }
    setStatus("loading models…");
    listModels(apiKey)
      .then((all) => {
        models = all;
        const prevA = [...modelASelect.options].find((o) => o.value)?.value;
        const prevB = [...modelBSelect.options].find((o) => o.value)?.value;
        while (modelASelect.firstChild) modelASelect.removeChild(modelASelect.firstChild);
        while (modelBSelect.firstChild) modelBSelect.removeChild(modelBSelect.firstChild);
        const defaultA = prevA && all.some((m) => m.id === prevA) ? prevA : all[0]?.id;
        const defaultB = prevB && all.some((m) => m.id === prevB) ? prevB : all[Math.min(1, all.length - 1)]?.id;
        for (const m of all) {
          const optA = el("option", "", m.name ?? m.id);
          optA.setAttribute("value", m.id);
          if (m.id === defaultA) optA.selected = true;
          modelASelect.appendChild(optA);
          const optB = el("option", "", m.name ?? m.id);
          optB.setAttribute("value", m.id);
          if (m.id === defaultB) optB.selected = true;
          modelBSelect.appendChild(optB);
        }
        modelA = defaultA;
        modelB = defaultB;
        setStatus(`${all.length} tool-capable models loaded`);
      })
      .catch((e) => {
        setStatus("could not load models: " + (e instanceof Error ? e.message : String(e)));
      });
  }

  function setStatus(s: string): void {
    statusText.textContent = s;
  }

  function startRun(): void {
    if (run) {
      // completed/errored run — start a fresh one
    }
    transcriptEl.innerHTML = "";
    const runConfig = {
      apiKey,
      modelA,
      modelB,
      promptA,
      promptB,
      temperature,
      dataset: scenario.dataset,
      onTranscript: (entry: TranscriptEntry) => renderEntry(transcriptEl, entry),
      onStatus: setStatus,
      onDone: (reason: string) => {
        setStatus(reason);
        if (run) {
          const snap: TestRunSettings = {
            scenario: scenario.name,
            modelA,
            modelB,
            promptA,
            promptB,
            temperature,
            seed,
            timestamp: new Date().toISOString(),
            budgetUsed: run.getTurnCount(),
            transcript: run.getTranscript(),
          };
          runLog.unshift(snap);
          renderRunLog(runLogPanel, snap);
        }
      },
    };
    run = new AgentRun(runConfig);
    run.start();
  }

  function renderRunLog(panel: HTMLElement, latest: TestRunSettings) {
    panel.innerHTML = "";
    panel.appendChild(el("h3", "", "Run log"));
    const list = el("div", "run-list");
    for (const r of runLog) {
      const item = el("div", "run-item");
      const meta = `${r.scenario} · A=${r.modelA} · B=${r.modelB} · T=${r.temperature} · ${new Date(r.timestamp).toLocaleTimeString()}`;
      item.appendChild(el("p", "run-meta", meta));
      if (r === latest) item.style.outline = "2px solid #888";
      list.appendChild(item);
    }
    panel.appendChild(list);
  }

  function renderPromptCard(container: HTMLElement, entries: TranscriptEntry[]): void {
    container.innerHTML = "";
    if (entries.length === 0) {
      container.appendChild(el("p", "empty", "Nothing yet. Press Run to begin. (Budget: " + MAX_TURNS + " exchanges.)"));
    }
    for (const e of entries) renderEntry(container, e);
  }

  function renderEntry(container: HTMLElement, entry: TranscriptEntry): void {
    switch (entry.kind) {
      case "message": {
        let node = msgNodes.get(entry);
        if (!node) {
          node = el("div", "msg " + (entry.side === "A" ? "msg-a" : "msg-b"));
          node.appendChild(el("span", "msg-side", entry.side === "A" ? "A :" : "B :"));
          node.appendChild(el("div", "msg-body"));
          container.appendChild(node);
          msgNodes.set(entry, node);
          node.dataset.rendered = "0";
        }
        const bodyEl = node.querySelector(".msg-body") as HTMLElement;
        const rendered = Number(node.dataset.rendered ?? "0");
        const text = entry.text;
        if (text.length > rendered) {
          bodyEl.textContent = (bodyEl.textContent ?? "") + text.slice(rendered);
          node.dataset.rendered = String(text.length);
        }
        node.classList.toggle("streaming", !!entry.partial);
        scroll();
        return;
      }
      case "tool-call": {
        const node = el("div", "tool-call");
        node.appendChild(el("span", "tool-call-name", "🔧 " + entry.tool));
        node.appendChild(el("pre", "tool-call-args", JSON.stringify(entry.args, null, 2)));
        container.appendChild(node);
        scroll();
        return;
      }
      case "tool-result": {
        const node = el("div", "tool-result");
        const summary = entry.summary.length > 800 ? entry.summary.slice(0, 800) + "…" : entry.summary;
        node.appendChild(el("span", "tool-result-label", "↩ result"));
        node.appendChild(el("pre", "tool-result-body", summary));
        container.appendChild(node);
        scroll();
        return;
      }
      case "artifact": {
        const node = el("div", "artifact");
        const link = el("a", "artifact-link", "⬇ download " + entry.artifact.name + " (" + entry.artifact.byteLength + " b)");
        link.href = URL.createObjectURL(new Blob([entry.artifact.text], { type: "text/plain" }));
        link.download = entry.artifact.name;
        node.appendChild(link);
        container.appendChild(node);
        scroll();
        return;
      }
      case "note":
        container.appendChild(el("p", "note", entry.text));
        return;
      case "error":
        container.appendChild(el("p", "error-entry", "⚠ " + entry.text));
        return;
    }
  }

  // Tracks streaming deltas per message entry object (identity-based).
  const msgNodes = new WeakMap<TranscriptEntry, HTMLElement>();

  function scroll(): void {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function exportRun(sc: Scenario, mA: string, mB: string, pA: string, pB: string, tmp: number, sd: string, r: AgentRun): void {
    const snap: TestRunSettings = {
      scenario: sc.name,
      modelA: mA,
      modelB: mB,
      promptA: pA,
      promptB: pB,
      temperature: tmp,
      seed: sd,
      timestamp: new Date().toISOString(),
      budgetUsed: r.getTurnCount(),
      transcript: r.getTranscript(),
    };
    const text = JSON.stringify(snap, null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `agent-handshake-${sc.name.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("exported " + snap.transcript.length + " transcript entries");
  }
}

const appRoot = document.getElementById("app");
if (appRoot) mount(appRoot);