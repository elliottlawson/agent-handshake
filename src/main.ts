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

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

interface ModelPicker {
  root: HTMLElement;
  setItems(items: ModelInfo[]): void;
  setValue(id: string): void;
  getValue(): string;
  reset(): void;
}

/**
 * A searchable single-select combobox for the (potentially large) model list.
 * Keyboard: type to filter, ↑/↓ to move, Enter to pick, Esc to close.
 */
function modelPicker(onChange: (id: string) => void): ModelPicker {
  let items: ModelInfo[] = [];
  let value = "";
  let query = "";
  let visible: ModelInfo[] = [];
  let active = 0;

  const root = el("div", "model-picker");
  const trigger = el("input", "model-picker-value") as HTMLInputElement;
  trigger.readOnly = true;
  trigger.placeholder = "Loading models…";
  trigger.title = "Pick a model";
  const menu = el("div", "model-picker-menu");
  const search = el("input", "model-picker-search") as HTMLInputElement;
  search.placeholder = "Search models…";
  const listEl = el("div", "model-picker-list");
  menu.append(search, listEl);
  root.append(trigger, menu);

  const labelFor = (id: string): string => {
    const m = items.find((x) => x.id === id);
    return m ? m.name ?? m.id : id;
  };

  const open = (): void => {
    root.classList.add("open");
    search.value = query;
    renderList();
    search.focus();
    search.select();
  };

  const close = (): void => {
    root.classList.remove("open");
    trigger.blur();
  };

  const commit = (id: string): void => {
    value = id;
    trigger.value = labelFor(id);
    trigger.title = id;
    onChange(id);
    query = "";
    close();
  };

  const renderList = (): void => {
    const q = search.value.trim().toLowerCase();
    query = q;
    visible =
      q === ""
        ? [...items]
        : items.filter((m) => (m.name ?? "").toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    listEl.innerHTML = "";
    if (items.length === 0) {
      listEl.appendChild(el("div", "model-picker-empty", "No models loaded — enter an API key first"));
      return;
    }
    if (visible.length === 0) {
      listEl.appendChild(el("div", "model-picker-empty", `No models match "${search.value.trim()}"`));
      return;
    }
    active = Math.min(Math.max(active, 0), visible.length - 1);
    visible.forEach((m, i) => {
      const row = el("button", "model-picker-item" + (i === active ? " active" : ""));
      row.type = "button";
      row.appendChild(el("span", "model-picker-name", m.name ?? m.id));
      row.appendChild(el("span", "model-picker-id", m.id));
      row.addEventListener("click", () => commit(m.id));
      row.addEventListener("mousemove", () => {
        if (active !== i) {
          active = i;
          toggleActive(row, true);
        }
      });
      listEl.appendChild(row);
    });
    scrollActiveIntoView();
  };

  const toggleActive = (row: HTMLElement, on: boolean): void => {
    if (on) row.classList.add("active");
    else row.classList.remove("active");
  };

  const scrollActiveIntoView = (): void => {
    const activeRow = listEl.children[active] as HTMLElement | undefined;
    activeRow?.scrollIntoView({ block: "nearest" });
  };

  const moveHighlight = (delta: number): void => {
    if (visible.length === 0) return;
    (listEl.children[active] as HTMLElement | undefined)?.classList.remove("active");
    active = (active + delta + visible.length) % visible.length;
    (listEl.children[active] as HTMLElement | undefined)?.classList.add("active");
    scrollActiveIntoView();
  };

  trigger.addEventListener("click", open);
  trigger.addEventListener("focus", open);
  search.addEventListener("input", renderList);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = visible[active];
      if (m) commit(m.id);
    } else if (e.key === "Escape") {
      close();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (root.classList.contains("open") && !root.contains(e.target as Node)) close();
  });

  return {
    root,
    setItems(next: ModelInfo[]): void {
      items = next;
      if (value && !items.some((m) => m.id === value)) value = "";
      trigger.value = value ? labelFor(value) : "Loading models…";
      trigger.title = value || "Pick a model";
      if (root.classList.contains("open")) renderList();
    },
    setValue(id: string): void {
      value = id;
      trigger.value = labelFor(id);
      trigger.title = id;
    },
    getValue(): string {
      return value;
    },
    reset(): void {
      items = [];
      value = "";
      query = "";
      trigger.value = "Loading models…";
      trigger.title = "Pick a model";
      listEl.innerHTML = "";
      root.classList.remove("open");
    },
  };
}

const KEY_STORAGE = "agent-handshake:openrouter-key";

export function mount(root: HTMLElement): void {
  root.innerHTML = "";

  // ---- state -------------------------------------------------------------
  let scenario: Scenario = getScenario(SCENARIOS[0].id);
  let modelA = DEFAULT_MODEL;
  let modelB = DEFAULT_MODEL;
  let promptA = scenario.defaultPromptA;
  let promptB = scenario.defaultPromptB;
  let temperature = 0;
  let seed = scenario.defaultSeed;
  let apiKey = localStorage.getItem(KEY_STORAGE) ?? "";
  let run: AgentRun | null = null;
  let runLog: TestRunSettings[] = [];

  const statusText = el("span", "status-text", "idle");

  // ---- layout ------------------------------------------------------------
  const header = el("header", "header");
  header.appendChild(el("h1", "title", "agent-handshake"));
  header.appendChild(el("p", "tagline", "Simulate AI-to-AI interaction without a structured API."));

  // ---- scenario bar: scenario picker + primary run controls + status ----
  const scenarioBar = el("div", "scenario-bar");
  const scenarioSel = el("select", "scenario-select");
  for (const s of SCENARIOS) {
    const opt = el("option", "", s.name);
    opt.setAttribute("value", s.id);
    scenarioSel.appendChild(opt);
  }
  const btnRun = el("button", "btn primary", "Run");
  const btnStop = el("button", "btn danger", "Stop");
  btnRun.addEventListener("click", () => {
    if (!apiKey) {
      setStatus("set an OpenRouter API key in the footer first");
      return;
    }
    if (!modelA || !modelB) {
      setStatus("pick a model for both sides (Advanced → Refresh models if the list is empty)");
      return;
    }
    startRun();
  });
  btnStop.addEventListener("click", () => run?.stop());

  // ---- advanced (collapsed): temp, seed, models, pause/step/resume, run log, export ----
  const details = el("details", "advanced") as HTMLDetailsElement;
  const summary = el("summary", "advanced-summary", "Advanced");
  summary.title = "Seed, temperature, model refresh, pause/step/resume, export, run log";
  const advanced = el("div", "advanced-body");

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

  const btnPause = el("button", "btn", "Pause");
  const btnStep = el("button", "btn", "Step");
  const btnResume = el("button", "btn", "Resume");
  const btnExport = el("button", "btn", "Export");
  const btnViewLog = el("button", "btn", "Run log");

  btnPause.addEventListener("click", () => run?.pause());
  btnStep.addEventListener("click", () => run?.step());
  btnResume.addEventListener("click", () => run?.resume());

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

  advanced.append(el("label", "lbl", "Temp"), tempInput, el("label", "lbl", "Seed"), seedInput, refreshModelsBtn, btnPause, btnStep, btnResume, btnExport, btnViewLog);
  details.append(summary, advanced);
  scenarioBar.append(el("label", "lbl", "Scenario"), scenarioSel, btnRun, btnStop, details, statusText);

  // ---- run log ------------------------------------------------------------
  const runLogPanel = el("div", "run-log-panel");
  runLogPanel.id = "run-log-panel";
  runLogPanel.hidden = true;

  // ---- setup: configure both sides --------------------------------------
  const setup = el("div", "setup");

  // LEFT: Client AI
  const left = el("section", "setup-pane client");
  left.appendChild(el("h2", "col-title", "Client AI"));
  left.appendChild(el("p", "hint", "Asks for data in natural language. No tools."));
  const pickerA = modelPicker((id) => {
    modelA = id;
  });
  pickerA.setValue(DEFAULT_MODEL);
  const aModelWrap = el("label", "lbl", "Model");
  aModelWrap.appendChild(pickerA.root);
  left.appendChild(aModelWrap);
  const aPrompt = el("textarea", "prompt-input");
  aPrompt.rows = 6;
  aPrompt.value = promptA;
  aPrompt.addEventListener("input", () => {
    promptA = aPrompt.value;
  });
  left.appendChild(aPrompt);

  // RIGHT: Data AI
  const right = el("section", "setup-pane data");
  right.appendChild(el("h2", "col-title", "Data AI"));
  right.appendChild(el("p", "hint", "Owns the dataset; reads it only through tools."));
  const pickerB = modelPicker((id) => {
    modelB = id;
  });
  pickerB.setValue(DEFAULT_MODEL);
  const bModelWrap = el("label", "lbl", "Model");
  bModelWrap.appendChild(pickerB.root);
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
  bPrompt.rows = 6;
  bPrompt.value = promptB;
  bPrompt.addEventListener("input", () => {
    promptB = bPrompt.value;
  });
  right.appendChild(bPrompt);

  setup.append(left, right);

  // ---- timeline: ONE linear chronological flow ---------------------------
  const timeline = el("section", "timeline");
  const transcriptEl = el("div", "transcript");
  transcriptEl.dataset.testid = "transcript";
  timeline.appendChild(el("h2", "col-title", "The negotiation"));
  timeline.appendChild(transcriptEl);

  // ---- footer ----------------------------------------------------------------
  const footer = el("footer", "api-key-footer");
  const keyGroup = el("div", "key-group");
  const keyInput = el("input") as HTMLInputElement;
  keyInput.type = "password";
  keyInput.placeholder = "OpenRouter API key (stays in this browser)";
  keyInput.value = apiKey;
  keyInput.title = "OpenRouter API key — stored only in this browser's localStorage";
  let keyLoadTimer: ReturnType<typeof setTimeout> | null = null;
  keyInput.addEventListener("input", () => {
    apiKey = keyInput.value.trim();
    localStorage.setItem(KEY_STORAGE, apiKey);
    if (apiKey) {
      if (keyLoadTimer) clearTimeout(keyLoadTimer);
      keyLoadTimer = setTimeout(loadModels, 400);
    } else {
      resetModelSelects();
    }
  });
  const btnClearKey = el("button", "btn", "Clear");
  btnClearKey.title = "Remove the stored key from this browser";
  btnClearKey.addEventListener("click", () => {
    apiKey = "";
    keyInput.value = "";
    localStorage.removeItem(KEY_STORAGE);
    resetModelSelects();
    setStatus("API key cleared");
  });
  keyGroup.append(el("label", "lbl", "Key"), keyInput, btnClearKey);
  footer.append(keyGroup);
  footer.appendChild(
    el(
      "p",
      "key-note",
      "Your key is used only in this tab to call OpenRouter — it never leaves the browser. Source is open: github.com/elliottlawson/agent-handshake.",
    ),
  );

  root.append(header, scenarioBar, runLogPanel, setup, timeline, footer);

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
    resetModelSelects();
    loadModels();
  });

  refreshModelsBtn.addEventListener("click", loadModels);

  (async function init() {
    loadModels();
    renderPromptCard(transcriptEl, []);
  })();

  function resetModelSelects(): void {
    pickerA.reset();
    pickerB.reset();
    modelA = DEFAULT_MODEL;
    modelB = DEFAULT_MODEL;
  }

  function loadModels() {
    if (!apiKey) {
      setStatus("enter an API key, then refresh models");
      return;
    }
    setStatus("loading models…");
    listModels(apiKey)
      .then((all) => {
        const prevA = pickerA.getValue();
        const prevB = pickerB.getValue();
        pickerA.setItems(all);
        pickerB.setItems(all);
        const defaultA = prevA && all.some((m) => m.id === prevA) ? prevA : all[0]?.id;
        const defaultB = prevB && all.some((m) => m.id === prevB) ? prevB : all[Math.min(1, all.length - 1)]?.id;
        pickerA.setValue(defaultA);
        pickerB.setValue(defaultB);
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