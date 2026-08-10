# agent-handshake

A browser-only lab for simulating AI-to-AI interaction **without a structured API**.

Two agents converse in plain English. One asks for data, the other owns a dataset and can only read it through a small set of capped tools. There is no REST, no CRUD, no GraphQL, no protocol between them — they have to invent one, and you watch.

You can edit both agents' prompts, pick a different model per side, and re-run to see how the negotiation changes.

## How to run

This is a static site. It runs entirely in your browser — no backend, no accounts.

1. Open the hosted page (or run `npm install && npm run dev` locally).
2. Paste an **OpenRouter API key** into the footer. It is stored in your browser's localStorage and sent only to `openrouter.ai`.
3. Pick a scenario in the scenario bar at the top.
4. Pick a model for the Client AI (A) and the Data AI (B).
5. Press **Run** and watch.

Your key is used only in this tab. It never reaches any server we run, and the code is open for audit here.

## What you see

- **Client AI, left** — the agent with no tools. It asks for data in natural language.
- **Conversation, middle** — the live transcript. The Data AI's tool calls are rendered as cards, so nothing is hidden.
- **Data AI, right** — the agent that owns a dataset. Its fixed toolkit is `inspect`, `query`, `page`, `deliver` (all capped).
- **Controls** — Run/Stop live in the scenario bar; Pause, Step, Resume, Temperature, Seed, Export and Run log live under **Advanced**. Temperature defaults to 0; same seed + same prompts = same data.
- **Run log** — completed runs are listed for side-by-side comparison.
- **Export** — download a JSON snapshot of the whole run: transcript, tool calls, both prompts, models, temperature, seed, timestamp.

There are no baked-in evals. The user is the judge.

## Scenarios

| Scenario | Dataset | What to watch |
|---|---|---|
| One Job | Contractor registry, ~5k rows | How a single exact record is requested and shaped |
| Catalog Filter | Product catalog, ~40k rows | Filtering and pagination negotiation |
| The Big Pull | ~1M transactions + customers + line items (relational) | Format choice, chunking, and whether A pulls raw or negotiates aggregation |
| The Wire | Append-only event stream | A and B invent a cursor/delta protocol; the Tick button advances time |

All data is synthetic and deterministic from the seed. Nothing is hosted, nothing is installed, nothing leaves the browser except the call to the model provider.

## Privacy

- Only two network calls exist: the OpenRouter models list and the OpenRouter chat API — both with your key.
- No analytics, no tracking, no remote code. Read `src/openrouter.ts` to see every request.

## Development

```
npm install
npm run dev     # local dev server
npm run build   # static build to dist/
```

Run the engine tests with `npx tsx logic-test.mts` and `npx tsx loop-test.mts`.