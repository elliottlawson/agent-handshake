import { generateDataset } from "./src/datasets";
import { queryDataset, pageDataset } from "./src/datasets";
import { buildToolSchemas } from "./src/tools";
import { executeTool } from "./src/tools";

const checks = [];

function check(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail });
}

// 1. Contractors: query by eq license, count 1
const contractors = generateDataset("contractors", "one-job-v1");
check("contractors rowcount", contractors.rowCount("contractors") === 5000, contractors.rowCount("contractors"));
const firstRow = contractors.rows("contractors", 7);
const r1 = queryDataset(contractors, {
  collection: "contractors",
  filter: [{ field: "license_id", op: "eq", value: firstRow.license_id }],
  limit: 10,
}, 100);
check("contractor eq query finds 1", r1.totalCount === 1 && r1.rows.length === 1, JSON.stringify(r1));

// 2. Products: filtered subset + pagination
const products = generateDataset("products", "catalog-v1");
const r2 = queryDataset(products, {
  collection: "products",
  filter: [{ field: "category", op: "eq", value: "kitchen" }, { field: "price_cents", op: "lt", value: 4000 }, { field: "stock", op: "gt", value: 0 }, { field: "status", op: "eq", value: "active" }],
  limit: 3,
}, 100);
check("products kitchen filter returns rows", r2.totalCount > 0, JSON.stringify({ total: r2.totalCount, sample: r2.rows[0] }));
check("products has cursor", typeof r2.cursor === "string", r2.cursor);

if (r2.cursor) {
  const r2b = pageDataset(products, r2.cursor, 100);
  check("page returns next page", r2b.rows.length > 0, JSON.stringify({ rows: r2b.rows.length, cursor: r2b.cursor }));
  check("page preserves filter semantics", r2b.totalCount === r2.totalCount, `${r2b.totalCount} vs ${r2.totalCount}`);
}

// 3. Big Pull: groupBy aggregation
const big = generateDataset("big-pull", "bigpull-v1");
const r3 = queryDataset(big, {
  collection: "transactions",
  filter: [{ field: "ts", op: "gte", value: "2025-01-01T00:00:00.000Z" }, { field: "ts", op: "lt", value: "2026-01-01T00:00:00.000Z" }],
  groupBy: { by: "customer_id", agg: "sum", field: "amount_cents" },
  limit: 5,
}, 100);
check("big-pull groupBy 2025 works", r3.totalCount > 1 && r3.rows.length === 5, JSON.stringify({ groups: r3.totalCount, first: r3.rows[0] }));
check("groupBy has count+sum", !!r3.rows[0]?.count && r3.rows[0]?.sum !== undefined, JSON.stringify(r3.rows[0]));

// raw pull path
const r3raw = queryDataset(big, {
  collection: "transactions",
  filter: [{ field: "ts", op: "gte", value: "2025-01-01T00:00:00.000Z" }, { field: "ts", op: "lt", value: "2026-01-01T00:00:00.000Z" }],
  limit: 2,
}, 100);
check("big-pull raw 2025 pull works", r3raw.totalCount > 0, JSON.stringify({ total: r3raw.totalCount, row: r3raw.rows[0] }));

// 4. The Wire: tick adds rows, events monotonic
const wire = generateDataset("events", "wire-v1");
const before = wire.rowCount("events");
wire.tick();
const after = wire.rowCount("events");
check("wire tick grows dataset", after === before + 160, `${before} -> ${after}`);
const lastId = wire.rows("events", after - 1).event_id;
const older = wire.rows("events", before - 1).event_id;
check("wire event_ids monotonic", String(older) < String(lastId), `${older} < ${lastId}`);

// 5. Toolkit schemas + tool execution
const env = { dataset: contractors, artifacts: [] };
const schemas = buildToolSchemas(contractors);
check("toolkit has 4 tools", schemas.length === 4, schemas.map((s) => s.function.name).join(","));
check("toolkit schemas flat (no $ref/$defs/anyOf)", !JSON.stringify(schemas).includes("$ref") && !JSON.stringify(schemas).includes("$defs") && !JSON.stringify(schemas).includes("anyOf"), "checked");
const inspectRes = await executeTool(env, { id: "1", name: "inspect", arguments: { collection: "contractors" } });
check("inspect fetchable", inspectRes.summary.includes('"rowCount":5000'), inspectRes.summary.slice(0, 80));
const deliverRes = await executeTool(env, { id: "2", name: "deliver", arguments: { name: "test.csv", format: "csv", rows: [{ a: 1, b: "x,y" }, { a: 2, b: "z" }] } });
check("deliver makes artifact", deliverRes.artifact !== undefined && env.artifacts.length === 1, deliverRes.summary);
check("deliver csv escapes comma", deliverRes.artifact.text.includes('"x,y"') || deliverRes.artifact.text.includes("x\\,y"), deliverRes.artifact.text.slice(0, 40));

// 6. Seed determinism
const c1 = generateDataset("contractors", "seed-A").rows("contractors", 100).license_id;
const c2 = generateDataset("contractors", "seed-A").rows("contractors", 100).license_id;
const c3 = generateDataset("contractors", "seed-B").rows("contractors", 100).license_id;
check("same seed -> same data", c1 === c2, `${c1} vs ${c2}`);
check("different seed -> different data", c2 !== c3, `${c2} vs ${c3}`);

let pass = 0;
for (const c of checks) {
  console.log((c.pass ? "PASS" : "FAIL") + "  " + c.name + (c.pass ? "" : "  <-- " + c.detail));
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);