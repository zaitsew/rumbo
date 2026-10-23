import { ObservationSchema, type Observation } from "../../core/schema";
import { observationId } from "./id";
import { SourceError, addHours, requestJson, toMinor } from "./http";
import { countryOfCity } from "./places";
import { childAges, type Env, type SearchContext, type Source, type SourceQuery } from "./types";

/**
 * LiteAPI (Nuitee Connect) hotel rates: a hotel list for the city, then the cheapest rate per hotel.
 * PAID, per decision D2 and POLICY section 11: off unless LITEAPI_KEY is set AND RUMBO_ALLOW_PAID_LITEAPI=1.
 *
 * Verified in LiteAPI's docs (docs.liteapi.travel, fetched 2026-10-23): base https://api.liteapi.travel/v3.0,
 * header `X-API-Key`, GET /data/hotels (cityName, countryCode, limit; returns id, name, stars, rating,
 * main_photo), POST /hotels/min-rates (hotelIds, occupancies, checkin, checkout, currency,
 * guestNationality, timeout; returns data[].hotelId, price, offerId).
 * NOTE for the owner: LiteAPI's own pricing page says rates, prebook and book are free within the terms at
 * a "reasonable look-to-book ratio", and charges $0.01 per Places request and $0.05 per price-index
 * request. The "$0.01 a search" in D2 may therefore be wrong for this path. The gate stays until the
 * owner decides (docs/SOURCES.md).
 * UNVERIFIED: whether min-rates `price` is the total for the stay (assumed) or per night.
 */
export const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const MAX_HOTELS = 40;
const MAX_RESULTS = 10;
const PRICE_TTL_HOURS = 6;

interface LHotel { id: string; name: string; stars?: number; rating?: number; city?: string; country?: string }
export interface LiteHotels { data?: LHotel[] }
export interface LiteMinRates { data?: { hotelId: string; price: number; offerId?: string }[] }

type StayQuery = Extract<SourceQuery, { kind: "stays" }>;

export function mapLiteapi(hotels: LiteHotels, rates: LiteMinRates, q: StayQuery, now: Date): Observation[] {
  const byId = new Map((hotels.data ?? []).map((h) => [h.id, h]));
  const seenAt = now.toISOString();
  const out: Observation[] = [];
  for (const r of [...(rates.data ?? [])].sort((a, b) => a.price - b.price)) {
    const h = byId.get(r.hotelId);
    if (!h || !(r.price > 0)) continue;
    out.push(ObservationSchema.parse({
      kind: "stay",
      id: observationId("stay", h.name, q.place, q.check_in, q.check_out),
      provenance: { source: "liteapi", seen_at: seenAt, expires_at: addHours(now, PRICE_TTL_HOURS) },
      title: `${h.name}, ${q.place}`,
      place: q.place,
      country: h.country ?? q.country,
      tags: [],
      check_in: q.check_in,
      check_out: q.check_out,
      price_total: { amount_minor: toMinor(r.price, q.currency), currency: q.currency.toUpperCase() },
      stay_kind: "hotel",
      rating: typeof h.rating === "number" && h.rating > 0 ? Math.min(10, h.rating) : undefined,
      name: h.name,
    }));
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export function createLiteapiSource(): Source {
  const hotelCache = new Map<string, LiteHotels>();
  const cacheKey = (q: StayQuery) => `${q.place.toLowerCase()}|${(q.country ?? countryOfCity(q.place) ?? "").toUpperCase()}`;
  return {
    name: "liteapi",
    kinds: ["stay"],
    paid: true,
    dailyCap: 100, // $0.01 a call would be at most $1 a day
    enabled: (env: Env) => Boolean(env.LITEAPI_KEY) && env.RUMBO_ALLOW_PAID_LITEAPI === "1",
    why_disabled(env) {
      if (!env.LITEAPI_KEY) return "set LITEAPI_KEY (liteapi.travel dashboard) and RUMBO_ALLOW_PAID_LITEAPI=1 once the price is approved";
      if (env.RUMBO_ALLOW_PAID_LITEAPI !== "1") return "paid source: set RUMBO_ALLOW_PAID_LITEAPI=1 to approve the price (docs/SOURCES.md)";
      return null;
    },
    callsFor: (q) => (q.kind === "stays" ? (hotelCache.has(cacheKey(q)) ? 1 : 2) : 0),
    async search(q, ctx: SearchContext) {
      if (q.kind !== "stays") return [];
      const env = ctx.env ?? process.env;
      const key = env.LITEAPI_KEY;
      if (!key) throw new SourceError("liteapi: LITEAPI_KEY is not set");
      const headers = { "x-api-key": key };
      const ck = cacheKey(q);
      let hotels = hotelCache.get(ck);
      if (!hotels) {
        const u = new URL(`${LITEAPI_BASE}/data/hotels`);
        u.searchParams.set("cityName", q.place);
        const cc = (q.country ?? countryOfCity(q.place))?.toUpperCase();
        if (cc) u.searchParams.set("countryCode", cc);
        u.searchParams.set("limit", String(MAX_HOTELS));
        hotels = await requestJson<LiteHotels>(ctx, { url: u.toString(), headers });
        hotelCache.set(ck, hotels);
      }
      const ids = (hotels.data ?? []).map((h) => h.id).slice(0, MAX_HOTELS);
      if (!ids.length) return [];
      const rates = await requestJson<LiteMinRates>(ctx, {
        url: `${LITEAPI_BASE}/hotels/min-rates`,
        method: "POST",
        headers,
        body: {
          hotelIds: ids,
          occupancies: [{ adults: q.adults, ...(childAges(q).length ? { children: childAges(q) } : {}) }],
          checkin: q.check_in,
          checkout: q.check_out,
          currency: q.currency.toUpperCase(),
          guestNationality: env.RUMBO_GUEST_NATIONALITY ?? "ES",
          timeout: 10,
        },
      });
      return mapLiteapi(hotels, rates, q, ctx.now);
    },
  };
}

export const liteapi = createLiteapiSource();
