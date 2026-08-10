import type { Dataset, FilterClause, QueryResult, QuerySpec } from "./types";
import { dateInRange, intBetween, isoDate, mulberry32, pickFrom, seedFor } from "./prng";

const ONE_DAY = 86400000;

function matches(row: Record<string, unknown>, clauses: FilterClause[]): boolean {
  for (const c of clauses) {
    const v = row[c.field];
    switch (c.op) {
      case "eq":
        if (String(v) !== String(c.value)) return false;
        break;
      case "neq":
        if (String(v) === String(c.value)) return false;
        break;
      case "lt":
        if (!cmpLT(v, c.value)) return false;
        break;
      case "lte":
        if (cmpLT(c.value, v)) return false;
        break;
      case "gt":
        if (!cmpLT(c.value, v)) return false;
        break;
      case "gte":
        if (cmpLT(v, c.value)) return false;
        break;
      case "contains":
        if (!String(v).toLowerCase().includes(String(c.value).toLowerCase())) return false;
        break;
    }
  }
  return true;
}

// Numeric values compare numerically; everything else (ISO dates, strings) compares lexicographically.
// ISO timestamps sort correctly as strings, so this keeps date-range filters working.
function cmpLT(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a < b;
  return String(a) < String(b);
}

function project(row: Record<string, unknown>, fields: string[] | undefined): Record<string, unknown> {
  if (!fields) return row;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f];
  return out;
}

function compare(a: Record<string, unknown>, b: Record<string, unknown>, field: string, dir: "asc" | "desc") {
  const av = a[field];
  const bv = b[field];
  const n = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
  return dir === "asc" ? n : -n;
}

/**
 * Full dataset querying used by the toolkit's query/page tools.
 * Kept deliberately simple: scans the (lazily generated) row index space.
 */
function encodeCursor(start: number, spec: QuerySpec, pageSize: number): string {
  return JSON.stringify({ start, spec: { collection: spec.collection, filter: spec.filter ?? [], fields: spec.fields ?? null, sort: spec.sort ?? null }, pageSize });
}

export function queryDataset(
  dataset: Dataset,
  spec: QuerySpec,
  pageSize: number,
): QueryResult {
  const total = dataset.rowCount(spec.collection);
  const limit = Math.min(spec.limit ?? pageSize, pageSize);
  const hits: { row: Record<string, unknown> }[] = [];
  for (let i = 0; i < total; i++) {
    if (matches(dataset.rows(spec.collection, i), spec.filter ?? [])) {
      hits.push({ row: dataset.rows(spec.collection, i) });
    }
  }
  if (spec.sort) hits.sort((a, b) => compare(a.row, b.row, spec.sort!.field, spec.sort!.dir));
  if (spec.groupBy) {
    const groups = new Map<string, { count: number; sum?: number }>();
    for (const { row } of hits) {
      const key = String(row[spec.groupBy.by]);
      const g = groups.get(key) ?? { count: 0, sum: undefined };
      g.count++;
      if (spec.groupBy.agg === "sum" && spec.groupBy.field !== undefined) {
        g.sum = (g.sum ?? 0) + Number(row[spec.groupBy.field]);
      }
      groups.set(key, g);
    }
    const rows = [...groups.entries()]
      .map(([k, g]) => ({ key: k, count: g.count, ...(g.sum !== undefined ? { sum: g.sum } : {}) }))
      .slice(0, limit);
    const truncated = groups.size > limit;
    return { rows, totalCount: groups.size, cursor: null, truncated };
  }
  const page = hits.slice(0, limit).map(({ row }) => project(row, spec.fields));
  const cursor = hits.length > limit ? encodeCursor(limit, spec, pageSize) : null;
  return { rows: page, totalCount: hits.length, cursor };
}

export function pageDataset(dataset: Dataset, decoded: string, pageSize: number): QueryResult {
  let parsed: { start: number; spec: { collection: string; filter: FilterClause[]; fields: string[] | null; sort: { field: string; dir: "asc" | "desc" } | null } };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { rows: [], totalCount: 0, cursor: null };
  }
  const { start, spec } = parsed;
  const total = dataset.rowCount(spec.collection);
  const limit = Math.min(pageSize, pageSize);
  const hits: { row: Record<string, unknown> }[] = [];
  for (let i = 0; i < total; i++) {
    if (matches(dataset.rows(spec.collection, i), spec.filter)) {
      hits.push({ row: dataset.rows(spec.collection, i) });
    }
  }
  if (spec.sort) hits.sort((a, b) => compare(a.row, b.row, spec.sort!.field, spec.sort!.dir));
  const page = hits.slice(start, start + limit).map(({ row }) => project(row, spec.fields ?? undefined));
  const next = start + limit;
  const cursor = hits.length > next ? encodeCursor(next, { collection: spec.collection, filter: spec.filter, fields: spec.fields ?? undefined, sort: spec.sort ?? undefined }, pageSize) : null;
  const truncated = cursor !== null;
  return { rows: page, totalCount: hits.length, cursor, truncated };
}

// ---------------------------------------------------------------------------
// Scenario datasets
// ---------------------------------------------------------------------------

const CONTRACTOR_NAMES = [
  "Blue Mountain Construction",
  "Apex Electrical Co.",
  "First Avenue Plumbing",
  "Summit Roofing",
  "Ironline Welding",
  "Cascade Masonry",
  "Granite Builders",
  "Harbor HVAC",
  "Northline Painting",
  "Brick & Beam Restorations",
  "Keystone Foundation Works",
  "Cornerstone Carpentry",
  "Ridgeline Solar",
  "Riverbend Landscaping",
  "Sable Security Installers",
  "Vantage Insulation",
  "Crestline Fire Safety",
  "Eagle Eye Pest & Seal",
];

const PRINCIPALS = ["J. Alvarez", "M. Chen", "P. Okafor", "S. Ivanov", "T. Brooks", "L. Nakamura", "R. Delgado", "K. Singh", "D. Novak", "F. Weber", "G. Fontaine", "H. Osei"];

function genContractors(seed: string): Dataset {
  const fields = [
    { name: "license_id", type: "string" as const, description: "Unique contractor license identifier" },
    { name: "company_name", type: "string" as const, description: "Legal business name" },
    { name: "principal_name", type: "string" as const, description: "Responsible principal" },
    { name: "status", type: "string" as const, description: "active, suspended, or expired" },
    { name: "years_active", type: "int" as const, description: "Years since licensure" },
    { name: "address", type: "string" as const, description: "Street address" },
    { name: "risk_tier", type: "string" as const, description: "low, med, or high" },
    { name: "issued_date", type: "date" as const, description: "Date license issued" },
  ];
  const rowCount = 5000;
  const rows = (i: number) => {
    const rng = mulberry32(seedFor(seed, "contractors", i));
    const year = 2005 + Math.floor(rng() * 20);
    return {
      license_id: "LIC-" + year + "-" + String(Math.floor(rng() * 9000) + 1000),
      company_name: pickFrom(rng, CONTRACTOR_NAMES),
      principal_name: pickFrom(rng, PRINCIPALS),
      status: pickFrom(rng, ["active", "active", "active", "suspended", "expired"]),
      years_active: intBetween(rng, 0, 40),
      address: intBetween(rng, 1, 9999) + " " + pickFrom(rng, ["Main St", "Oak Ave", "Maple Dr", "King Rd", "Cedar Ln", "Union Blvd", "Park Way", "Hill St"]),
      risk_tier: pickFrom(rng, ["low", "low", "med", "med", "high"]),
      issued_date: isoDate(new Date(year, 0, 1 + Math.floor(rng() * 365))),
    };
  };
  return {
    name: "contractors",
    description: "Contractor registry with licensing and risk data.",
    seed,
    collections: [{ name: "contractors", fields, rowCount }],
    rowCount: () => rowCount,
    rows: (collection, index) => {
      void collection;
      return rows(index);
    },
  };
}

const PRODUCT_CATEGORIES = ["kitchen", "electronics", "outdoor", "office", "toys", "home", "tools"];
const ADJECTIVES = ["Steel", "Compact", "Pro", "Premium", "Classic", "Neo", "Turbo", "Eco", "Aero", "Lux"];
const NOUNS = ["Blender", "Knife Set", "Grill", "Speaker", "Lamp", "Chair", "Drill", "Scale", "Camera", "Kettle", "Mixer", "Pan Set"];

function genProducts(seed: string): Dataset {
  const fields = [
    { name: "sku", type: "string" as const, description: "Stock keeping unit" },
    { name: "name", type: "string" as const, description: "Product name" },
    { name: "category", type: "string" as const, description: "Product category" },
    { name: "price_cents", type: "int" as const, description: "Price in cents" },
    { name: "stock", type: "int" as const, description: "Units in stock" },
    { name: "status", type: "string" as const, description: "active or retired" },
    { name: "release_date", type: "date" as const, description: "First available date" },
    { name: "tags", type: "string[]" as const, description: "Feature tags" },
  ];
  const rowCount = 40000;
  const rows = (i: number) => {
    const rng = mulberry32(seedFor(seed, "products", i));
    const category = pickFrom(rng, PRODUCT_CATEGORIES);
    return {
      sku: "SKU-" + String(Math.floor(rng() * 900000) + 100000),
      name: pickFrom(rng, ADJECTIVES) + " " + pickFrom(rng, NOUNS),
      category,
      price_cents: intBetween(rng, 500, 25000),
      stock: intBetween(rng, 0, 500),
      status: pickFrom(rng, ["active", "active", "retired"]),
      release_date: isoDate(dateInRange(rng, Date.parse("2020-01-01"), Date.parse("2026-01-01"))),
      tags: rng() < 0.4 ? [pickFrom(rng, ["smart", "wireless", "energy", "vintage", "portable"])] : [],
    };
  };
  return {
    name: "products",
    description: "Product catalog with pricing and inventory.",
    seed,
    collections: [{ name: "products", fields, rowCount }],
    rowCount: () => rowCount,
    rows: (collection, index) => {
      void collection;
      return rows(index);
    },
  };
}

const CUSTOMER_TIERS = ["basic", "premium", "enterprise"];
const COUNTRIES = ["US", "CA", "GB", "DE", "FR", "JP", "AU", "BR", "IN", "MX"];
const CHANNELS = ["web", "pos", "mobile", "partner"];
const TX_STATUS = ["completed", "completed", "refunded", "pending"];
const LINE_PRODUCTS = ["widget", "gadget", "module", "assembly", "spare", "kit"];

function genBigPull(seed: string): Dataset {
  const customerFields = [
    { name: "customer_id", type: "string" as const, description: "Unique customer id" },
    { name: "name", type: "string" as const, description: "Customer name" },
    { name: "country", type: "string" as const, description: "Country code" },
    { name: "tier", type: "string" as const, description: "basic, premium, or enterprise" },
    { name: "created_at", type: "date" as const, description: "Account creation date" },
  ];
  const txnFields = [
    { name: "txn_id", type: "string" as const, description: "Unique transaction id" },
    { name: "ts", type: "date" as const, description: "Transaction timestamp" },
    { name: "customer_id", type: "string" as const, description: "Customer who transacted" },
    { name: "amount_cents", type: "int" as const, description: "Transaction amount in cents" },
    { name: "channel", type: "string" as const, description: "web, pos, mobile, or partner" },
    { name: "status", type: "string" as const, description: "completed, refunded, or pending" },
  ];
  const lineFields = [
    { name: "txn_id", type: "string" as const, description: "Owning transaction id" },
    { name: "product", type: "string" as const, description: "Product name" },
    { name: "qty", type: "int" as const, description: "Quantity" },
    { name: "unit_price_cents", type: "int" as const, description: "Unit price in cents" },
  ];
  const customerRows = 200000;
  const txnRows = 1000000;
  const lineRows = 2000000;

  const customerId = (i: number) => "C-" + String(i).padStart(6, "0");

  const rowFor = (collection: string, index: number): Record<string, unknown> => {
    if (collection === "customers") {
      const rng = mulberry32(seedFor(seed, "customers", index));
      return {
        customer_id: customerId(index),
        name: pickFrom(rng, PRINCIPALS),
        country: pickFrom(rng, COUNTRIES),
        tier: pickFrom(rng, CUSTOMER_TIERS),
        created_at: isoDate(dateInRange(rng, Date.parse("2010-01-01"), Date.parse("2026-01-01"))),
      };
    }
    if (collection === "transactions") {
      const rng = mulberry32(seedFor(seed, "transactions", index));
      const ts = dateInRange(rng, Date.parse("2023-01-01"), Date.parse("2026-01-01"));
      const amount = [intBetween(rng, 500, 90000), Math.floor(rng() * 900) + 100];
      return {
        txn_id: "T-" + String(index).padStart(7, "0"),
        ts: isoDate(ts),
        customer_id: customerId(Math.floor(rng() * customerRows)),
        amount_cents: pickFrom(rng, [amount[0], amount[1]]),
        channel: pickFrom(rng, CHANNELS),
        status: pickFrom(rng, TX_STATUS),
      };
    }
    if (collection === "line_items") {
      const rng = mulberry32(seedFor(seed, "line_items", index));
      return {
        txn_id: "T-" + String(Math.floor(rng() * txnRows)).padStart(7, "0"),
        product: pickFrom(rng, LINE_PRODUCTS),
        qty: intBetween(rng, 1, 9),
        unit_price_cents: intBetween(rng, 300, 12000),
      };
    }
    return {};
  };

  return {
    name: "big-pull",
    description: "Relational finance dataset: transactions, customers, line items.",
    seed,
    collections: [
      { name: "customers", fields: customerFields, rowCount: customerRows },
      { name: "transactions", fields: txnFields, rowCount: txnRows },
      { name: "line_items", fields: lineFields, rowCount: lineRows },
    ],
    rowCount: (c) => (c === "customers" ? customerRows : c === "transactions" ? txnRows : lineRows),
    rows: rowFor,
  };
}

const EVENT_SOURCES = ["app", "web", "infra", "security", "billing"];
const EVENT_TYPES = ["login", "purchase", "deploy", "alert", "signup", "error", "config_change"];
const SEVERITIES = ["info", "info", "warn", "critical"];
const EVENT_DAY_COUNT = 30;
const EVENTS_PER_DAY = 160;
const EVENT_HISTORY = EVENT_DAY_COUNT * EVENTS_PER_DAY;

function genEvents(seed: string): Dataset {
  let dayClock = 0;
  const fields = [
    { name: "event_id", type: "string" as const, description: "Monotonic event id" },
    { name: "ts", type: "date" as const, description: "Event timestamp" },
    { name: "source", type: "string" as const, description: "Source system" },
    { name: "event_type", type: "string" as const, description: "Event class" },
    { name: "severity", type: "string" as const, description: "info, warn, or critical" },
    { name: "payload", type: "string" as const, description: "Free-form event payload" },
  ];
  const rowCount = () => EVENT_HISTORY + dayClock * EVENTS_PER_DAY;
  const rowFor = (collection: string, index: number) => {
    void collection;
    const rng = mulberry32(seedFor(seed, "events", index));
    const day = Math.floor(index / EVENTS_PER_DAY);
    const ts = new Date(Date.parse("2026-07-01T00:00:00Z") + day * ONE_DAY + Math.floor(rng() * ONE_DAY));
    return {
      event_id: "EVT-" + String(index).padStart(6, "0"),
      ts: isoDate(ts),
      source: pickFrom(rng, EVENT_SOURCES),
      event_type: pickFrom(rng, EVENT_TYPES),
      severity: pickFrom(rng, SEVERITIES),
      payload: "payload-" + String(Math.floor(rng() * 1e6)),
    };
  };
  return {
    name: "events",
    description: "Append-only event stream that grows as time is ticked forward.",
    seed,
    collections: [{ name: "events", fields, rowCount: rowCount() }],
    rowCount,
    rows: rowFor,
    tick: () => {
      dayClock++;
    },
    tickLabel: "Tick (+1 day)",
  };
}

export function generateDataset(kind: string, seed: string): Dataset {
  switch (kind) {
    case "contractors":
      return genContractors(seed);
    case "products":
      return genProducts(seed);
    case "big-pull":
      return genBigPull(seed);
    case "events":
      return genEvents(seed);
  }
  throw new Error("unknown dataset kind: " + kind);
}

export function collectionNames(dataset: Dataset): string[] {
  return dataset.collections.map((c) => c.name);
}