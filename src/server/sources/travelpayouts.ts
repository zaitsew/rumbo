import { ObservationSchema, type Observation } from "../../core/schema";
import { flightId, flightNo, legKey } from "./id";
import { SourceError, addHours, requestJson, toMinor } from "./http";
import { placeOfAirport } from "./places";
import type { Env, Source, SourceQuery } from "./types";

/**
 * Travelpayouts / Aviasales Data API: cached fares (what travellers searched on Aviasales in the last
 * days), free with a token. Good for "cheapest month" and "anywhere" scans, not for a quote.
 *
 * Verified against Travelpayouts' public docs (travelpayouts.github.io/slate): base URL, the
 * `x-access-token` header, the `token` parameter, GZIP advice.
 * UNVERIFIED (the support-site page for /aviasales/v3/prices_for_dates answers 403 to bots; the field
 * list comes from open-source clients and the deprecation notices on the v1 endpoints): the v3 request
 * parameters (departure_at, return_at, one_way, unique, sorting, direct, limit, currency) and the
 * response fields (origin_airport, destination_airport, transfers, return_transfers, duration, link).
 * The endpoint itself exists: it answers 401 without a token.
 */
export const TP_BASE = "https://api.travelpayouts.com";
const MAX_MONTHS = 3;
const MAX_REQUESTS = 12;
const MAX_RESULTS = 30;
/** v3 carries no expiry (the v1 endpoints did). Cached fares are good for a day; unverified. */
const CACHE_TTL_HOURS = 24;

interface TpItem {
  origin?: string; destination?: string; origin_airport?: string; destination_airport?: string;
  price: number; airline?: string; flight_number?: string | number;
  departure_at: string; return_at?: string | null; transfers?: number; return_transfers?: number;
  duration?: number; duration_to?: number; duration_back?: number; link?: string; expires_at?: string; currency?: string;
}
export interface TpResponse { success?: boolean; data?: TpItem[]; currency?: string; error?: string }

type FlightQuery = Extract<SourceQuery, { kind: "flights" }>;

function monthsOf(q: FlightQuery): string[] {
  const out: string[] = [];
  let m = q.window.from.slice(0, 7);
  const end = q.window.to.slice(0, 7);
  while (m <= end && out.length < MAX_MONTHS) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  return out;
}

export interface TpRequest { origin: string; destination?: string; month: string }

export function planRequests(q: FlightQuery): TpRequest[] {
  const dests: (string | undefined)[] = q.destination === "anywhere" ? [undefined] : q.destination;
  const reqs: TpRequest[] = [];
  for (const origin of q.origin) for (const destination of dests) for (const month of monthsOf(q)) reqs.push({ origin, destination, month });
  return reqs.slice(0, MAX_REQUESTS);
}

export function requestUrl(r: TpRequest, q: FlightQuery): string {
  const u = new URL(`${TP_BASE}/aviasales/v3/prices_for_dates`);
  u.searchParams.set("origin", r.origin);
  if (r.destination) u.searchParams.set("destination", r.destination);
  u.searchParams.set("departure_at", r.month);
  u.searchParams.set("one_way", q.nights ? "false" : "true");
  u.searchParams.set("unique", r.destination ? "false" : "true"); // anywhere: one fare per destination
  u.searchParams.set("sorting", "price");
  u.searchParams.set("direct", q.max_stops === 0 ? "true" : "false");
  u.searchParams.set("currency", q.currency.toLowerCase());
  u.searchParams.set("limit", "100");
  return u.toString();
}

/** Aviasales' `link` is a path; the marker makes it an affiliate link. */
export function bookUrl(link: string | undefined, marker: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const u = new URL(link, "https://www.aviasales.com");
    if (marker) u.searchParams.set("marker", marker);
    return u.toString();
  } catch {
    return undefined;
  }
}

const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

export function mapTravelpayouts(res: TpResponse, q: FlightQuery, now: Date, marker?: string): Observation[] {
  if (res.success === false) throw new SourceError(`travelpayouts: ${res.error ?? "success=false"}`);
  const currency = (res.currency ?? q.currency).toUpperCase();
  const seenAt = now.toISOString();
  const out: Observation[] = [];
  for (const it of res.data ?? []) {
    if (!it.departure_at || typeof it.price !== "number") continue;
    const depart_date = it.departure_at.slice(0, 10);
    if (depart_date < q.window.from || depart_date > q.window.to) continue;
    const return_date = it.return_at ? it.return_at.slice(0, 10) : undefined;
    if (q.nights && return_date) {
      const n = nightsBetween(depart_date, return_date);
      if (n < q.nights.min || n > q.nights.max) continue;
    }
    const origin = it.origin_airport ?? it.origin;
    const destination = it.destination_airport ?? it.destination;
    if (!origin || !destination) continue;
    const place = placeOfAirport(it.destination ?? destination);
    const stops = Math.max(it.transfers ?? 0, it.return_transfers ?? 0);
    if (q.max_stops !== undefined && stops > q.max_stops) continue;
    const url = bookUrl(it.link, marker);
    out.push(ObservationSchema.parse({
      kind: "flight",
      id: flightId({ origin, destination, depart_date, return_date, legs: it.airline && it.flight_number ? [legKey({ carrier: it.airline, number: String(it.flight_number), from: origin, to: destination, departLocal: it.departure_at })] : [] }),
      provenance: { source: "travelpayouts", url, seen_at: seenAt, expires_at: it.expires_at ?? addHours(now, CACHE_TTL_HOURS) },
      title: `${origin} → ${place.city}, ${depart_date}${return_date ? ` – ${return_date}` : ""} (cached fare)`,
      place: place.city,
      country: place.country,
      tags: [],
      book_url: url,
      origin, destination, depart_date, return_date,
      price: { amount_minor: toMinor(it.price, currency), currency },
      stops,
      duration_minutes: it.duration_to ?? it.duration ?? undefined,
      legs: [],
      seller: "Aviasales",
    }));
  }
  return out.sort((a, b) => (a.kind === "flight" && b.kind === "flight" ? a.price.amount_minor - b.price.amount_minor : 0)).slice(0, MAX_RESULTS);
}

export const travelpayouts: Source = {
  name: "travelpayouts",
  kinds: ["flight"],
  paid: false,
  dailyCap: 500, // our own ceiling; Travelpayouts states no limit for the data endpoints
  enabled: (env: Env) => Boolean(env.TRAVELPAYOUTS_TOKEN),
  why_disabled: (env: Env) => (env.TRAVELPAYOUTS_TOKEN ? null : "set TRAVELPAYOUTS_TOKEN (free, travelpayouts.com > Tools > API)"),
  callsFor: (q) => (q.kind === "flights" ? planRequests(q).length : 0),
  async search(q, ctx) {
    if (q.kind !== "flights") return [];
    const env = ctx.env ?? process.env;
    const token = env.TRAVELPAYOUTS_TOKEN;
    if (!token) throw new SourceError("travelpayouts: TRAVELPAYOUTS_TOKEN is not set");
    const merged: Observation[] = [];
    for (const r of planRequests(q)) {
      const res = await requestJson<TpResponse>(ctx, { url: requestUrl(r, q), headers: { "x-access-token": token, "accept-encoding": "gzip, deflate" } });
      merged.push(...mapTravelpayouts(res, q, ctx.now, env.TRAVELPAYOUTS_MARKER));
    }
    return merged;
  },
};
