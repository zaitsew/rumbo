import { ObservationSchema, type Observation } from "../../core/schema";
import { observationId } from "./id";
import { SourceError, addHours, requestJson, toMinor } from "./http";
import type { Env, Source, SourceQuery } from "./types";

/**
 * Tiqets Distributor API v2, Content API: GET /products filtered by city. Read from Tiqets' machine-readable
 * docs (developers.tiqets.dev, fetched 2026-10-23): base https://api.tiqets.com/v2, header
 * `Authorization: Token <key>`, query `city_name` or `city_id`, `lang`, `currency`, `page_size` (max 100),
 * `sort`. Default rate limit 15 requests a second. A key made in the affiliate portal reaches the catalogue
 * and availability endpoints; `product_url` carries the affiliate tracking.
 * We filter by `city_name` (the docs call it handy but recommend `city_id`); resolving ids would cost a
 * page through /cities per lookup.
 */
export const TIQETS_BASE = "https://api.tiqets.com/v2";
const MAX_RESULTS = 20;
const PRICE_TTL_HOURS = 24;

interface TqProduct {
  id: string; title: string; tagline?: string | null; product_url?: string; sale_status?: string | null;
  city_name?: string; country_name?: string; price?: number | null; currency?: string | null;
  ratings?: { average?: number | null; total?: number } | null; duration?: string | null;
}
export interface TiqetsResponse { success?: boolean; products?: TqProduct[]; pagination?: { total?: number } }

type ActivityQuery = Extract<SourceQuery, { kind: "activities" }>;

/** "02:30:00" → 150 minutes. */
export function minutesOf(hms: string | null | undefined): number | undefined {
  const m = /^(\d+):(\d{2})(?::\d{2})?$/.exec(hms ?? "");
  if (!m) return undefined;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins > 0 ? mins : undefined;
}

export function requestUrl(q: ActivityQuery): string {
  const u = new URL(`${TIQETS_BASE}/products`);
  u.searchParams.set("city_name", q.place);
  u.searchParams.set("lang", "en");
  u.searchParams.set("currency", (q.currency ?? "EUR").toUpperCase());
  u.searchParams.set("sort", "popularity");
  u.searchParams.set("page_size", String(MAX_RESULTS));
  return u.toString();
}

export function mapTiqets(res: TiqetsResponse, q: ActivityQuery, now: Date): Observation[] {
  const seenAt = now.toISOString();
  const out: Observation[] = [];
  for (const p of res.products ?? []) {
    if (p.sale_status && p.sale_status !== "available") continue;
    const avg = p.ratings?.average;
    out.push(ObservationSchema.parse({
      kind: "activity",
      id: observationId("activity", p.title, q.place, q.date),
      provenance: { source: "tiqets", url: p.product_url, seen_at: seenAt, expires_at: addHours(now, PRICE_TTL_HOURS) },
      title: p.title,
      place: q.place,
      country: p.country_name ?? q.country,
      tags: [],
      book_url: p.product_url,
      date: q.date,
      price: typeof p.price === "number" && p.currency ? { amount_minor: toMinor(p.price), currency: p.currency.toUpperCase() } : undefined,
      duration_minutes: minutesOf(p.duration),
      rating: typeof avg === "number" && avg > 0 ? Math.min(5, avg) : undefined,
    }));
  }
  return out;
}

export const tiqets: Source = {
  name: "tiqets",
  kinds: ["activity"],
  paid: false,
  dailyCap: 500, // our ceiling; Tiqets allows 15 requests a second
  enabled: (env: Env) => Boolean(env.TIQETS_API_KEY),
  why_disabled: (env: Env) => (env.TIQETS_API_KEY ? null : "set TIQETS_API_KEY (free, Tiqets affiliate portal > Tools > API tokens)"),
  async search(q, ctx) {
    if (q.kind !== "activities") return [];
    const key = (ctx.env ?? process.env).TIQETS_API_KEY;
    if (!key) throw new SourceError("tiqets: TIQETS_API_KEY is not set");
    const res = await requestJson<TiqetsResponse>(ctx, { url: requestUrl(q), headers: { authorization: `Token ${key}` } });
    return mapTiqets(res, q, ctx.now);
  },
};
