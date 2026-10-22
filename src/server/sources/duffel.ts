import { ObservationSchema, type Observation } from "../../core/schema";
import { flightId, flightNo } from "./id";
import { SourceError, addDays, addHours, requestJson, toMinor } from "./http";
import { placeOfAirport } from "./places";
import { withOffset } from "./time";
import type { Env, Source, SourceQuery } from "./types";

/**
 * Duffel flight offer requests. PAID, per decision D2 and POLICY section 11: off unless DUFFEL_TOKEN is
 * set AND RUMBO_ALLOW_PAID_DUFFEL=1. Searches are free below a 1,500:1 search-to-order ratio and cost
 * $0.005 each above it; an account that never orders pays for every search. Orders cost a fee plus 1% of
 * the order value (duffel.com/pricing). Rumbo never creates an order: this file has no call to /air/orders.
 *
 * Verified in Duffel's docs (duffel.com/docs/api/offer-requests/create-offer-request, fetched 2026-10-23):
 * POST https://api.duffel.com/air/offer_requests?return_offers=true, headers `Authorization: Bearer`,
 * `Duffel-Version: v2`, body data.slices[].{origin,destination,departure_date}, data.passengers[].type,
 * data.cabin_class, data.max_connections; offers[].{id,total_amount,total_currency,expires_at,owner.name,
 * slices[].segments[].{origin.iata_code,destination.iata_code,departing_at,arriving_at,
 * marketing_carrier.{name,iata_code},marketing_carrier_flight_number,duration}}.
 * UNVERIFIED: `time_zone` and `city_name` on the place objects (taken from Duffel's Place schema).
 */
export const DUFFEL_URL = "https://api.duffel.com/air/offer_requests";
const MAX_REQUESTS = 3;
const MAX_OFFERS = 10;

interface DPlace { iata_code: string; city_name?: string | null; iata_country_code?: string; time_zone?: string | null }
interface DSegment {
  origin: DPlace; destination: DPlace; departing_at: string; arriving_at: string;
  marketing_carrier?: { name?: string; iata_code?: string }; marketing_carrier_flight_number?: string;
}
interface DSlice { segments: DSegment[]; duration?: string | null }
export interface DuffelOffer {
  id: string; total_amount: string; total_currency: string; expires_at?: string; owner?: { name?: string }; slices: DSlice[];
}
export interface DuffelResponse { data?: { offers?: DuffelOffer[] }; errors?: { message?: string }[] }

type FlightQuery = Extract<SourceQuery, { kind: "flights" }>;

/** "PT02H26M" → 146. */
export function isoMinutes(d: string | null | undefined): number | undefined {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d ?? "");
  if (!m) return undefined;
  const mins = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return mins > 0 ? mins : undefined;
}

export function planPairs(q: FlightQuery): { origin: string; destination: string }[] {
  if (q.destination === "anywhere") return []; // Duffel needs a destination
  const pairs: { origin: string; destination: string }[] = [];
  for (const origin of q.origin) for (const destination of q.destination) pairs.push({ origin, destination });
  return pairs.slice(0, MAX_REQUESTS);
}

export function requestBody(q: FlightQuery, pair: { origin: string; destination: string }, today: string) {
  // One date per request keeps the bill small: the first day of the window, never in the past.
  const depart = q.window.from < today ? today : q.window.from;
  const slices = [{ origin: pair.origin, destination: pair.destination, departure_date: depart }];
  if (q.nights) slices.push({ origin: pair.destination, destination: pair.origin, departure_date: addDays(depart, q.nights.min) });
  return {
    data: {
      slices,
      passengers: Array.from({ length: q.adults }, () => ({ type: "adult" })),
      cabin_class: "economy",
      max_connections: Math.min(q.max_stops ?? 1, 2),
    },
  };
}

export function mapDuffel(res: DuffelResponse, q: FlightQuery, now: Date): Observation[] {
  if (res.errors?.length) throw new SourceError(`duffel: ${res.errors[0]?.message ?? "error"}`);
  const seenAt = now.toISOString();
  const pax = Math.max(1, q.adults);
  const out: Observation[] = [];
  for (const offer of res.data?.offers ?? []) {
    const outb = offer.slices[0];
    const back = offer.slices[1];
    const first = outb?.segments[0];
    const last = outb?.segments[outb.segments.length - 1];
    if (!outb || !first || !last) continue;
    const legsOf = (s: DSlice | undefined) =>
      (s?.segments ?? []).map((g) => ({
        from: g.origin.iata_code, to: g.destination.iata_code,
        depart_at: withOffset(g.departing_at, g.origin.time_zone ?? "UTC"),
        arrive_at: withOffset(g.arriving_at, g.destination.time_zone ?? "UTC"),
        carrier: g.marketing_carrier?.name ?? g.marketing_carrier?.iata_code ?? "",
        flight_no: flightNo(g.marketing_carrier?.iata_code, g.marketing_carrier_flight_number) || undefined,
      }));
    const depart_date = first.departing_at.slice(0, 10);
    const return_date = back?.segments[0]?.departing_at.slice(0, 10);
    const fallback = placeOfAirport(last.destination.iata_code);
    const place = last.destination.city_name ?? fallback.city;
    out.push(ObservationSchema.parse({
      kind: "flight",
      id: flightId({
        origin: first.origin.iata_code, destination: last.destination.iata_code, depart_date, return_date,
        first_flight: flightNo(first.marketing_carrier?.iata_code, first.marketing_carrier_flight_number),
      }),
      provenance: { source: "duffel", seen_at: seenAt, expires_at: offer.expires_at ?? addHours(now, 0.5) },
      title: `${first.origin.iata_code} → ${place}, ${depart_date}${return_date ? ` – ${return_date}` : ""}`,
      place,
      country: last.destination.iata_country_code ?? fallback.country,
      tags: [],
      origin: first.origin.iata_code,
      destination: last.destination.iata_code,
      depart_date,
      return_date,
      price: { amount_minor: Math.round(toMinor(offer.total_amount) / pax), currency: offer.total_currency.toUpperCase() },
      stops: Math.max(outb.segments.length - 1, back ? back.segments.length - 1 : 0),
      duration_minutes: isoMinutes(outb.duration),
      legs: [...legsOf(outb), ...legsOf(back)],
      seller: offer.owner?.name,
    }));
  }
  return out.sort((a, b) => (a.kind === "flight" && b.kind === "flight" ? a.price.amount_minor - b.price.amount_minor : 0)).slice(0, MAX_OFFERS);
}

export const duffel: Source = {
  name: "duffel",
  kinds: ["flight"],
  paid: true,
  dailyCap: 40, // $0.005 a search above the free ratio: at most $0.20 a day
  enabled: (env: Env) => Boolean(env.DUFFEL_TOKEN) && env.RUMBO_ALLOW_PAID_DUFFEL === "1",
  why_disabled(env) {
    if (!env.DUFFEL_TOKEN) return "set DUFFEL_TOKEN (duffel.com dashboard) and RUMBO_ALLOW_PAID_DUFFEL=1 once the price is approved";
    if (env.RUMBO_ALLOW_PAID_DUFFEL !== "1") return "paid source: set RUMBO_ALLOW_PAID_DUFFEL=1 to approve the price (docs/SOURCES.md)";
    return null;
  },
  callsFor: (q) => (q.kind === "flights" ? planPairs(q).length : 0),
  async search(q, ctx) {
    if (q.kind !== "flights") return [];
    const token = (ctx.env ?? process.env).DUFFEL_TOKEN;
    if (!token) throw new SourceError("duffel: DUFFEL_TOKEN is not set");
    const today = ctx.now.toISOString().slice(0, 10);
    const merged: Observation[] = [];
    for (const pair of planPairs(q)) {
      const res = await requestJson<DuffelResponse>(ctx, {
        url: `${DUFFEL_URL}?return_offers=true`,
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "duffel-version": "v2" },
        body: requestBody(q, pair, today),
      });
      merged.push(...mapDuffel(res, q, ctx.now));
    }
    return merged;
  },
};
