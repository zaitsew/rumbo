/**
 * Live smoke test of the data sources. Run: npx tsx scripts/source-smoke.ts
 *
 * Always makes one Kiwi MCP search (VLC to LIS, about six weeks out) and prints the mapped observations.
 * Then makes one call to every keyed source whose env var is set. Paid sources run only when their
 * RUMBO_ALLOW_PAID_* flag is set too. Nothing here writes to a database. Keys are never printed.
 */
import type { Observation } from "../src/core/schema";
import { addDays } from "../src/server/sources/http";
import { ALL_SOURCES, describeSources, type SourceQuery } from "../src/server/sources";

try { process.loadEnvFile(".env"); } catch { /* no .env: the shell environment is enough */ }

const now = new Date();
const today = now.toISOString().slice(0, 10);
const from = addDays(today, 42);
const to = addDays(from, 2);

const money = (m: { amount_minor: number; currency: string }) => `${(m.amount_minor / 100).toFixed(2)} ${m.currency}`;

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
  ticketmaster: { kind: "events", place: "Valencia", country: "ES", window: { from: today, to: addDays(today, 45) } },
  viator: { kind: "activities", place: "Valencia", country: "ES", currency: "EUR" },
  tiqets: { kind: "activities", place: "Valencia", country: "ES", currency: "EUR" },
  liteapi: { kind: "stays", place: "Lisbon", country: "PT", check_in: from, check_out: addDays(from, 3), adults: 1, currency: "EUR" },
  duffel: { kind: "flights", origin: ["VLC"], destination: ["LIS"], window: { from, to }, adults: 1, currency: "EUR", max_stops: 1 },
};

console.log("sources:");
for (const s of describeSources(process.env)) {
  console.log(`  ${s.enabled ? "on " : "off"} ${s.name.padEnd(14)} cap ${String(s.dailyCap).padStart(4)}${s.paid ? "  PAID" : ""}${s.why_disabled ? `  - ${s.why_disabled}` : ""}`);
}

let failed = 0;
for (const src of ALL_SOURCES) {
  if (!src.enabled(process.env)) continue;
  const q = queries[src.name];
  if (!q) continue;
  const started = Date.now();
  try {
    const obs = await src.search(q, { now: new Date(), env: process.env, signal: AbortSignal.timeout(45_000) });
    console.log(`\n${src.name}: ${obs.length} observation(s) in ${Date.now() - started} ms (${src.callsFor?.(q) ?? 1} call(s))`);
    for (const o of obs.slice(0, src.name === "kiwi-mcp" ? 8 : 3)) console.log(`  ${line(o)}`);
    const o = obs[0];
    if (o) console.log(`  provenance: source=${o.provenance.source} seen_at=${o.provenance.seen_at} expires_at=${o.provenance.expires_at ?? "-"} url=${o.provenance.url ?? "-"}`);
  } catch (e) {
    failed++;
    console.log(`\n${src.name}: FAILED ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
