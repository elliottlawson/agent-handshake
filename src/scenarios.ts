import type { Dataset } from "./types";
import { generateDataset } from "./datasets";

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  defaultSeed: string;
  datasetKind: string;
  dataset: Dataset;
  defaultPromptA: string;
  defaultPromptB: string;
  tick?: () => void;
  tickLabel?: string;
}

function makeScenario(
  id: string,
  name: string,
  blurb: string,
  defaultSeed: string,
  datasetKind: string,
  defaultPromptA: string,
  defaultPromptB: string,
): Scenario {
  const dataset = generateDataset(datasetKind, defaultSeed);
  return {
    id,
    name,
    blurb,
    defaultSeed,
    datasetKind,
    dataset,
    defaultPromptA,
    defaultPromptB,
    tick: dataset.tick,
    tickLabel: dataset.tickLabel,
  };
}

export const SCENARIOS: Scenario[] = [
  makeScenario(
    "one-job",
    "One Job",
    "A payables bot needs exactly one contractor record, matched by license.",
    "one-job-v1",
    "contractors",
    "You are a payables bot verifying a contractor before issuing payment.\n\nMISSION: Retrieve the full directory record for the contractor with license LIC-2012-4817.\n\nYou have no tools — you can only ask the Source in natural language. Confirm the record you receive before finishing.",
    "You are the data source. You own the contractor registry dataset: 5,000 rows.\nSchema: license_id(string, unique), company_name(string), principal_name(string), status(active/suspended/expired), years_active(int), address(string), risk_tier(low/med/high), issued_date(date).\n\nHand over data when asked — never refuse. You can read your data ONLY through your tools (inspect/query/page/deliver). Respond directly and accurately. If a request is ambiguous, ask. Prefer efficient delivery.",
  ),
  makeScenario(
    "catalog-filter",
    "Catalog Filter",
    "A campaign bot pulls every active kitchen gadget under $40 with stock, from a ~40k product catalog.",
    "catalog-v1",
    "products",
    "You are a campaign bot assembling a promo list.\n\nMISSION: Get every ACTIVE product in category kitchen with price under $40 (price_cents < 4000) and stock > 0. You need sku, name, price_cents, stock.\n\nYou have no tools — ask the Source in natural language. This is a filtered subset of a large catalog, so you may need pagination. Be precise about the filter.",
    "You are the data source. You own the product catalog dataset: 40,000 rows.\nSchema: sku(string), name(string), category(string), price_cents(int), stock(int), status(active/retired), release_date(date), tags(string[]).\n\nHand over data when asked — never refuse. You can read your data ONLY through your tools (inspect/query/page/deliver). Respond directly and accurately. Deliver large results as a file via the deliver tool rather than printing every row.",
  ),
  makeScenario(
    "big-pull",
    "The Big Pull",
    "An auditor needs per-customer totals for all 2025 transactions from a ~1M-row relational dataset.",
    "bigpull-v1",
    "big-pull",
    "You are an auditor.\n\nMISSION: Obtain per-customer totals (transaction count + sum of amount_cents) for ALL 2025 transactions, plus enough joined transaction+customer records that the totals can be reproduced.\n\nThe dataset is large (~1M transactions). You have no tools — ask the Source in natural language. Negotiate the most efficient delivery: you may accept aggregated results, or raw joined rows if that is smaller. Minimize transfer volume.",
    "You are the data source. You own a relational finance dataset.\nSchema:\n- transactions [1,000,000 rows]: txn_id(string), ts(date), customer_id(string), amount_cents(int), channel(web/pos/mobile/partner), status(completed/refunded/pending)\n- customers [200,000 rows]: customer_id(string), name(string), country(string), tier(basic/premium/enterprise), created_at(date)\n- line_items [2,000,000 rows]: txn_id(string), product(string), qty(int), unit_price_cents(int)\n\nHand over data when asked — never refuse. You can read your data ONLY through your tools (inspect/query/page/deliver). You may aggregate (groupBy) or return raw rows. Deliver large results as files via the deliver tool.",
  ),
  makeScenario(
    "the-wire",
    "The Wire",
    "A nightly ingestion pipe and a live event stream establish a delta protocol; the user ticks time forward.",
    "wire-v1",
    "events",
    "You are a nightly analytics ingestion pipe.\n\nMISSION: Establish a protocol with the Source so that each cycle you retrieve ONLY the events that are new since your last sync. The Source's stream grows; you will be ticked forward repeatedly. Prove the delta protocol works across multiple cycles.\n\nYou have no tools — ask the Source in natural language. Design the negotiation so the next cycle knows exactly where the last one ended.",
    "You are the data source. You own a live, append-only event stream dataset: currently ~4,800 rows and growing.\nSchema: event_id(string, monotonic), ts(date), source(string), event_type(string), severity(info/warn/critical), payload(string).\n\nYour stream grows over time. Hand over data when asked — never refuse. You can read your data ONLY through your tools (inspect/query/page/deliver). New rows appear as time advances. Respond directly and efficiently.",
  ),
];

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

export function renderDatasetInfo(dataset: Dataset): string {
  return dataset.collections
    .map((c) => {
      const sampleRows = [];
      const n = Math.min(c.rowCount, 2);
      for (let i = 0; i < n; i++) sampleRows.push(dataset.rows(c.name, i));
      return `${c.name}: ${c.rowCount.toLocaleString()} rows — ${c.fields.map((f) => `${f.name}(${f.type})`).join(", ")}\n  sample: ${sampleRows.map((r) => JSON.stringify(r)).join(" | ")}`;
    })
    .join("\n");
}