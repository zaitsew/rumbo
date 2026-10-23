import { createHash } from "node:crypto";
import { ObservationSchema, type Observation } from "../core/schema";
import { flightId, legKey } from "./sources/id";
import type { Store } from "./store";

/**
 * Taking observations from an agent or an API client. One row at a time is checked, so one bad row
 * never costs the others. On top of the shared schema this enforces what the schema cannot:
 *   - an `id` is optional here (agents cannot hash reliably); the server derives a stable one,
 *   - a price must come with the page it was read on (`provenance.url` or `book_url`),
 *   - `seen_at` is not in the future, a zero fare is not a fare, dates run in order.
 * The AI never writes a number (D3): these checks keep an estimate from entering as a quote.
 */

export interface RejectedRow {
  index: number;
  error: string;
}

export interface IngestResult {
  /** Valid rows, including `skipped_older` ones. Stored rows are `inserted + updated`. */
  accepted: number;
  inserted: number;
  updated: number;
  skipped_older: number;
  rejected: RejectedRow[];
  /** Watches marked as checked now. */
  watches_marked: string[];
}

export interface IngestOptions {
  /** Stamped into `provenance.agent`. */
  agent?: string;
  now?: Date;
  /** Watches the caller checked even if nothing was found; they also come from `watch_id` on the rows. */
  checkedWatchIds?: string[];
}

const FUTURE_SLACK_MS = 10 * 60_000;

/** Fields that make an offer "the same offer", per kind; the source is included so two sellers stay two rows. */
function keyFields(o: Observation): (string | number | undefined)[] {
  const base = [o.kind, o.provenance.source, o.place.toLowerCase()];
  switch (o.kind) {
    case "flight": return base; // not used: flights go through `flightIdFor`
    case "stay": return [...base, o.name.toLowerCase(), o.check_in, o.check_out];
    case "car": return [...base, o.pickup.toLowerCase(), o.pickup_date, o.dropoff_date];
    case "activity": return [...base, o.title.toLowerCase(), o.date];
    case "event": return [...base, o.title.toLowerCase(), o.date, o.venue?.toLowerCase()];
    case "idea": return [...base, o.title.toLowerCase(), o.when?.from, o.when?.to];
  }
}

/**
 * Flights share the id scheme of the collectors (src/server/sources/id.ts): every leg of both
 * directions, with flight number, airports and local departure minute, so two itineraries on one route and date that
 * differ in a connection, a departure or the return never collide, and the same itinerary seen by
 * a collector and by an agent is one row. With no legs at all the id falls back to what identifies an offer: seller, source,
 * stops, duration, price currency and the page it books on. The price amount is never part of it,
 * so an exact repeat of the same offer updates the price.
 */
function flightIdFor(o: Extract<Observation, { kind: "flight" }>): string {
  const legs = o.legs.map((l) => legKey({ carrier: l.carrier, number: l.flight_no, from: l.from, to: l.to, departLocal: l.depart_at }));
  const extra = o.legs.length > 0 ? [] : [
    `seller:${o.seller ?? ""}`, `source:${o.provenance.source}`, `stops:${o.stops}`, `dur:${o.duration_minutes ?? ""}`,
    `cur:${o.price.currency}`, `book:${o.book_url ?? o.provenance.url ?? ""}`,
  ];
  return flightId({ origin: o.origin, destination: o.destination, depart_date: o.depart_date, return_date: o.return_date, legs: [...legs, ...extra] });
}

export function observationId(o: Observation): string {
  if (o.kind === "flight") return flightIdFor(o);
  const h = createHash("sha256").update(keyFields(o).map((v) => String(v ?? "")).join("|")).digest("hex").slice(0, 20);
  return `obs_${h}`;
}

function hasPrice(o: Observation): boolean {
  switch (o.kind) {
    case "flight": case "stay": return true;
    case "car": return o.price_total !== undefined;
    case "activity": return o.price !== undefined;
    case "event": return o.price_from !== undefined;
    case "idea": return false;
  }
}

/** Throws a short message when a schema-valid row still breaks a Rumbo rule. */
function checkRules(o: Observation, now: Date): void {
  const seen = Date.parse(o.provenance.seen_at);
  if (seen > now.getTime() + FUTURE_SLACK_MS) throw new Error("provenance.seen_at is in the future");
  if (o.provenance.expires_at && Date.parse(o.provenance.expires_at) <= seen) throw new Error("provenance.expires_at must be after seen_at");
  if (hasPrice(o) && !o.provenance.url && !o.book_url) {
    throw new Error("a price needs the page it was read on: set provenance.url (or book_url). Never estimate a price; drop it or post an `idea` without one");
  }
  // A trip already over is not rejected: the ranker marks it stale and keeps it out of the feed.
  switch (o.kind) {
    case "flight":
      if (o.price.amount_minor === 0) throw new Error("price 0 is not a fare");
      if (o.return_date && o.return_date < o.depart_date) throw new Error("return_date is before depart_date");
      break;
    case "stay":
      if (o.price_total.amount_minor === 0) throw new Error("price_total 0 is not a rate");
      if (o.check_out <= o.check_in) throw new Error("check_out must be after check_in");
      break;
    case "car":
      if (o.dropoff_date < o.pickup_date) throw new Error("dropoff_date is before pickup_date");
      break;
    default:
      break;
  }
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown[] }).issues)) {
    return (err as { issues: { path: PropertyKey[]; message: string }[] }).issues
      .slice(0, 4)
      .map((i) => `${i.path.map(String).join(".") || "(row)"}: ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/** Validates each row, stores the valid ones, and marks the watches that were checked. */
export function ingestObservations(store: Store, rows: unknown[], opts: IngestOptions = {}): IngestResult {
  const now = opts.now ?? new Date();
  const valid: Observation[] = [];
  const rejected: RejectedRow[] = [];

  rows.forEach((raw, index) => {
    try {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("a row must be an object");
      const row = { ...(raw as Record<string, unknown>) };
      const prov = typeof row.provenance === "object" && row.provenance !== null ? { ...(row.provenance as Record<string, unknown>) } : row.provenance;
      if (opts.agent && typeof prov === "object" && prov !== null) (prov as Record<string, unknown>).agent = opts.agent;
      row.provenance = prov;
      const hadId = typeof row.id === "string" && row.id.trim() !== "";
      row.id = hadId ? (row.id as string).trim() : "pending";
      let parsed = ObservationSchema.parse(row);
      if (!hadId) parsed = { ...parsed, id: observationId(parsed) };
      checkRules(parsed, now);
      valid.push(parsed);
    } catch (err) {
      rejected.push({ index, error: errorText(err) });
    }
  });

  // Same id twice in one call: the later row with the later seen_at wins, so count each id once.
  const byId = new Map<string, Observation>();
  for (const o of valid) {
    const prior = byId.get(o.id);
    if (!prior || Date.parse(o.provenance.seen_at) >= Date.parse(prior.provenance.seen_at)) byId.set(o.id, o);
  }
  const unique = [...byId.values()];
  const stored = store.upsertObservations(unique);

  const wanted = new Set<string>(opts.checkedWatchIds ?? []);
  for (const o of valid) if (o.watch_id) wanted.add(o.watch_id);
  const marked: string[] = [];
  for (const id of wanted) {
    const w = store.getWatch(id);
    if (!w) continue;
    store.upsertWatch({ ...w, last_run_at: now.toISOString() });
    marked.push(id);
  }

  return { accepted: valid.length, ...stored, rejected, watches_marked: marked };
}
