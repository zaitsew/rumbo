import { ObservationSchema, type Observation } from "../../core/schema";
import { observationId } from "./id";
import { SourceError, addHours, requestJson, toMinor } from "./http";
import type { Env, SearchContext, Source, SourceQuery } from "./types";

/**
 * Viator Partner API v2, Basic-access affiliate: destination lookup and product search. The paths,
 * headers and field names below are read from Viator's published OpenAPI document
 * (docs.viator.com/partner-api/technical, fetched 2026-10-23): base https://api.viator.com/partner,
 * header `exp-api-key`, `Accept: application/json;version=2.0`, `Accept-Language`, GET /destinations,
 * POST /products/search with `filtering.destination`, `sorting`, `pagination`, `currency`.
 * Rate limits are per endpoint in a rolling 10-second window, counted per partner account.
 * UNVERIFIED: the dollar value of `fromPrice` for a date range; `productUrl` is assumed to carry the
 * partner's tracking (the spec says it is the link where the customer completes the booking).
 */
export const VIATOR_BASE = "https://api.viator.com/partner";
const MAX_RESULTS = 20;
const PRICE_TTL_HOURS = 24;

interface VDestination { destinationId: number; name: string; type: string }
interface VProduct {
  productCode: string; title: string; productUrl?: string;
  reviews?: { combinedAverageRating?: number; totalReviews?: number };
  duration?: { fixedDurationInMinutes?: number; variableDurationFromMinutes?: number };
  pricing?: { summary?: { fromPrice?: number }; currency?: string };
}
export interface ViatorSearchResponse { products?: VProduct[]; totalCount?: number }
export interface ViatorDestinations { destinations?: VDestination[]; totalCount?: number }

type ActivityQuery = Extract<SourceQuery, { kind: "activities" }>;

function headers(key: string): Record<string, string> {
  return { "exp-api-key": key, accept: "application/json;version=2.0", "accept-language": "en-US" };
}

export function pickDestination(list: VDestination[], place: string): VDestination | undefined {
  const p = place.trim().toLowerCase();
  const named = list.filter((d) => d.name.trim().toLowerCase() === p);
  return named.find((d) => d.type === "CITY") ?? named[0];
}

export function mapViator(res: ViatorSearchResponse, q: ActivityQuery, currency: string, now: Date): Observation[] {
  const seenAt = now.toISOString();
  const out: Observation[] = [];
  for (const p of res.products ?? []) {
    const from = p.pricing?.summary?.fromPrice;
    const dur = p.duration?.fixedDurationInMinutes ?? p.duration?.variableDurationFromMinutes;
    out.push(ObservationSchema.parse({
      kind: "activity",
      id: observationId("activity", p.title, q.place, q.date),
      provenance: { source: "viator", url: p.productUrl, seen_at: seenAt, expires_at: addHours(now, PRICE_TTL_HOURS) },
      title: p.title,
      place: q.place,
      country: q.country,
      tags: [],
      book_url: p.productUrl,
      date: q.date,
      price: typeof from === "number" ? { amount_minor: toMinor(from, p.pricing?.currency ?? currency), currency: (p.pricing?.currency ?? currency).toUpperCase() } : undefined,
      duration_minutes: dur && dur > 0 ? dur : undefined,
      rating: p.reviews?.combinedAverageRating ? Math.min(5, p.reviews.combinedAverageRating) : undefined,
    }));
  }
  return out;
}

export function createViatorSource(): Source & { destinationCached(): boolean } {
  // Destination ids by lower-case name, filled from one GET /destinations and kept for the process.
  let destinations: VDestination[] | undefined;
  return {
    name: "viator",
    kinds: ["activity"],
    paid: false,
    dailyCap: 500, // our ceiling; Viator limits per 10-second window, not per day
    enabled: (env: Env) => Boolean(env.VIATOR_API_KEY),
    why_disabled: (env: Env) => (env.VIATOR_API_KEY ? null : "set VIATOR_API_KEY (free Basic-access affiliate key, partnerresources.viator.com)"),
    destinationCached: () => destinations !== undefined,
    callsFor: (q) => (q.kind === "activities" ? (destinations ? 1 : 2) : 0),
    async search(q, ctx: SearchContext) {
      if (q.kind !== "activities") return [];
      const key = (ctx.env ?? process.env).VIATOR_API_KEY;
      if (!key) throw new SourceError("viator: VIATOR_API_KEY is not set");
      if (!destinations) {
        const d = await requestJson<ViatorDestinations>(ctx, { url: `${VIATOR_BASE}/destinations`, headers: headers(key) });
        destinations = d.destinations ?? [];
      }
      const dest = pickDestination(destinations, q.place);
      if (!dest) return []; // Viator has no destination by that name; not an error
      const currency = (q.currency ?? "EUR").toUpperCase();
      const filtering: Record<string, unknown> = { destination: String(dest.destinationId) };
      if (q.date) { filtering.startDate = q.date; filtering.endDate = q.date; }
      const res = await requestJson<ViatorSearchResponse>(ctx, {
        url: `${VIATOR_BASE}/products/search`,
        method: "POST",
        headers: { ...headers(key), "content-type": "application/json;version=2.0" },
        body: { filtering, sorting: { sort: "DEFAULT" }, pagination: { start: 1, count: MAX_RESULTS }, currency },
      });
      return mapViator(res, q, currency, ctx.now);
    },
  };
}

export const viator = createViatorSource();
