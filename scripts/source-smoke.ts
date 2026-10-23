/**
 * Live smoke test of the data sources. Run: npx tsx scripts/source-smoke.ts
 *
 * Always makes one Kiwi MCP search (VLC to LIS, about six weeks out) and prints the mapped observations.
 * Then makes one call to every keyed free source whose env var is set. Paid sources (LiteAPI, Duffel) are
 * never called from this script. Calls go through runSources and a file ledger in runs/. Keys are never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Observation } from "../src/core/schema";
import { addDays, formatMinor } from "../src/server/sources/http";
import { ALL_SOURCES, describeSources, runSources, type CallLedger, type SourceQuery } from "../src/server/sources";

try { process.loadEnvFile(".env"); } catch { /* no .env: the shell environment is enough */ }

const now = new Date();
const today = now.toISOString().slice(0, 10);
const from = addDays(today, 42);
const to = addDays(from, 2);

const money = (m: { amount_minor: number; currency: string }) => `${formatMinor(m.amount_minor, m.currency)} ${m.currency}`;

function line(o: Observation): string {
  switch (o.kind) {
    case "flight":
      return `${o.origin}>${o.destination} ${o.depart_date}${o.return_date ? `..${o.return_date}` : ""}  ${money(o.price)}  stops ${o.stops}  ${o.seller ?? ""}  ${o.place}`;
    case "stay":
      return `${o.name}  ${o.check_in}..${o.check_out}  ${money(o.price_total)}${o.rating ? `  rating ${o.rating}` : ""}`;
    case "activity":
      return `${o.title}${o.price ? `  from ${money(o.price)}` : ""}${o.rating ? `  rating ${o.rating}` : ""}`;
    case "event":
      return `${o.date}  ${o.title}  @ ${o.venue ?? "?"}  [${o.tags.join(",")}]${o.price_from ? `  from ${money(o.price_from)}` : ""}`;
    default:
      return o.title;
  }
}

const queries: Record<string, SourceQuery> = {
  "kiwi-mcp": { kind: "flights", origin: ["VLC"], destination: ["LIS"], window: { from, to }, nights: { min: 3, max: 4 }, adults: 1, currency: "EUR", max_stops: 1 },
  travelpayouts: { kind: "flights", origin: ["VLC"], destination: ["LIS"], window: { from, to: addDays(from, 25) }, adults: 1, currency: "EUR" },
  viator: { kind: "activities", place: "Valencia", country: "ES", currency: "EUR" },
  tiqets: { kind: "activities", place: "Valencia", country: "ES", currency: "EUR" },
  liteapi: { kind: "stays", place: "Lisbon", country: "PT", check_in: from, check_out: addDays(from, 3), adults: 1, currency: "EUR" },
  duffel: { kind: "flights", origin: ["VLC"], destination: ["LIS"], window: { from, to }, adults: 1, currency: "EUR", max_stops: 1 },
};

console.log("sources:");
for (const s of describeSources(process.env)) {
  console.log(`  ${s.enabled ? "on " : "off"} ${s.name.padEnd(14)} cap ${String(s.dailyCap).padStart(4)}${s.paid ? "  PAID" : ""}${s.why_disabled ? `  - ${s.why_disabled}` : ""}`);
}

// Every call goes through runSources and a ledger kept in runs/ (gitignored), so repeated smoke runs
// count against each source's daily cap. The app's own SQLite ledger is separate: run this sparingly.
// Paid sources are never called from here, even when their env flags are set.
const LEDGER_FILE = "runs/source-smoke-ledger.json";
const stored: Record<string, number> = existsSync(LEDGER_FILE) ? JSON.parse(readFileSync(LEDGER_FILE, "utf8")) : {};
const ledger: CallLedger = {
  count: (source, day) => stored[`${source}|${day}`] ?? 0,
  add: (source, day, n) => {
    stored[`${source}|${day}`] = (stored[`${source}|${day}`] ?? 0) + n;
    mkdirSync("runs", { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(stored, null, 2));
  },
};

let failed = 0;
for (const src of ALL_SOURCES) {
  const q = queries[src.name];
  if (!q || !src.enabled(process.env)) continue;
  if (src.paid) {
    console.log(`\n${src.name}: PAID, not called from the smoke script (it is enabled in this environment; run it deliberately through the app).`);
    continue;
  }
  const started = Date.now();
  const r = await runSources([q], { sources: [src], ledger, env: process.env, now: new Date(), timeoutMs: 45_000 });
  const call = r.calls[0];
  if (!call?.ok) {
    failed++;
    console.log(`\n${src.name}: ${call?.skipped ? `SKIPPED (${call.skipped})` : "FAILED"} ${call?.error ?? ""}`);
    continue;
  }
  const obs = r.observations;
  console.log(`\n${src.name}: ${obs.length} observation(s) in ${Date.now() - started} ms (${call.n} call(s) charged; ${ledger.count(src.name, today)} of ${src.dailyCap} used today)`);
  for (const o of obs.slice(0, src.name === "kiwi-mcp" ? 8 : 3)) console.log(`  ${line(o)}`);
  const o = obs[0];
  if (o) console.log(`  provenance: source=${o.provenance.source} seen_at=${o.provenance.seen_at} expires_at=${o.provenance.expires_at ?? "-"} url=${o.provenance.url ?? "-"}`);
}
process.exit(failed ? 1 : 0);
