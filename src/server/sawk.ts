import { ObservationSchema, type Interest, type Observation } from "../core/schema";
import { SourceError, requestJson, toMinor } from "./sources/http";
import { observationId } from "./sources/id";
import type { Env, SearchContext, Source, SourceQuery } from "./sources/types";

/**
 * SAWk is Ivan's other tool: a ranked feed of offline events (concerts, exhibitions, talks) for the
 * cities he lives in and travels to. Rumbo reads it, never writes it (D7: events come from SAWk).
 *
 *   GET ${SAWK_URL}/api/feed?city=&from=&to=&limit=20   Authorization: Bearer ${SAWK_TOKEN}
 *   -> { from, to, items: [{ event: { id, title, startsAt, city, country, venue, category, tags,
 *        priceMin, currency, isFree, url, ticketUrl, ... }, score, reason, state }] }
 *
 * Without both env vars nothing is called and `sawkEvents` returns [].
 */

export const SAWK_LIMIT = 20;
/** An event is stale this long after it started when it has no end time. */
const DEFAULT_LENGTH_HOURS = 4;

/** SAWk category to Rumbo interest. A category with no counterpart adds no tag. */
const TAG_OF: Record<string, Interest> = {
  music: "concerts", nightlife: "nightlife", art: "museums", theatre: "culture", film: "culture",
  food: "food", sport: "sport-events", festival: "festivals", family: "family", outdoor: "nature",
};

interface SawkEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  city: string;
  country?: string | null;
  venue?: string | null;
  category?: string;
  priceMin?: number | null;
  currency?: string | null;
  isFree?: boolean | null;
  url?: string | null;
  ticketUrl?: string | null;
  cancelled?: boolean;
}
interface SawkFeed { items?: { event?: SawkEvent; score?: number; reason?: string }[] }

export function sawkConfigured(env: Env = process.env): boolean {
  return !!env.SAWK_URL?.trim() && !!env.SAWK_TOKEN?.trim();
}

export function sawkWhyDisabled(env: Env = process.env): string | null {
  if (!env.SAWK_URL?.trim()) return "SAWK_URL is not set; set it (and SAWK_TOKEN) to see events from SAWk";
  if (!env.SAWK_TOKEN?.trim()) return "SAWK_TOKEN is not set; create an agent token in SAWk and set it";
  return null;
}

const validUrl = (u: string | null | undefined): string | undefined => {
  if (!u) return undefined;
  try {
    return new URL(u).toString();
  } catch {
    return undefined;
  }
};

/** Map one SAWk event. Null when it cannot be an Observation (cancelled, no date, a bad shape). */
export function mapSawkEvent(e: SawkEvent, now: Date, place: string, country?: string): Observation | null {
  if (!e || e.cancelled || !e.id || !e.title || !e.startsAt) return null;
  const date = String(e.startsAt).slice(0, 10); // the offset keeps the local day in the first ten characters
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const endDate = e.endsAt ? String(e.endsAt).slice(0, 10) : undefined;
  const startMs = Date.parse(e.startsAt);
  const endMs = e.endsAt ? Date.parse(e.endsAt) : NaN;
  const expiresMs = Number.isNaN(endMs) ? (Number.isNaN(startMs) ? NaN : startMs + DEFAULT_LENGTH_HOURS * 3_600_000) : endMs;
  const url = validUrl(e.ticketUrl) ?? validUrl(e.url);
  const currency = (e.currency ?? "").toUpperCase();
  const price_from =
    e.isFree === true
      ? { amount_minor: 0, currency: currency || "EUR" }
      : typeof e.priceMin === "number" && Number.isFinite(e.priceMin) && e.priceMin >= 0 && /^[A-Z]{3}$/.test(currency)
        ? { amount_minor: toMinor(e.priceMin, currency), currency }
        : undefined;
  const tag = e.category ? TAG_OF[e.category] : undefined;
  const obs = {
    kind: "event" as const,
    id: observationId("event", "sawk", e.id),
    provenance: {
      source: "sawk",
      ...(validUrl(e.url) ? { url: validUrl(e.url) } : {}),
      seen_at: now.toISOString(),
      ...(Number.isNaN(expiresMs) ? {} : { expires_at: new Date(expiresMs).toISOString() }),
    },
    title: e.title.slice(0, 200),
    place: e.city || place,
    country: e.country ?? country,
    tags: tag ? [tag] : [],
    ...(url ? { book_url: url } : {}),
    date,
    ...(endDate && endDate !== date ? { end_date: endDate } : {}),
    ...(e.venue ? { venue: e.venue.slice(0, 200) } : {}),
    ...(price_from ? { price_from } : {}),
  };
  const parsed = ObservationSchema.safeParse(obs);
  return parsed.success ? parsed.data : null;
}

export interface SawkOptions {
  env?: Env;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
}

/**
 * Events in `place` between `window.from` and `window.to` from the person's SAWk feed. [] when SAWk is
 * not configured. A failing SAWk throws a SourceError (never with the token in it); callers that must
 * not fail catch it, and `runSources` records it.
 */
export async function sawkEvents(place: string, country: string | undefined, window: { from: string; to: string }, opts: SawkOptions = {}): Promise<Observation[]> {
  const env = opts.env ?? process.env;
  if (!sawkConfigured(env)) return [];
  const base = env.SAWK_URL!.trim().replace(/\/+$/, "");
  const url = `${base}/api/feed?${new URLSearchParams({ city: place, from: window.from, to: window.to, limit: String(SAWK_LIMIT) })}`;
  const ctx: SearchContext = { now: opts.now ?? new Date(), env, signal: opts.signal, fetch: opts.fetch };
  const body = await requestJson<SawkFeed>(ctx, { url, headers: { authorization: `Bearer ${env.SAWK_TOKEN!.trim()}` } });
  if (!body || !Array.isArray(body.items)) throw new SourceError("sawk: the feed has no items list");
  const out: Observation[] = [];
  const seen = new Set<string>();
  for (const item of body.items.slice(0, SAWK_LIMIT)) {
    const o = item?.event ? mapSawkEvent(item.event, ctx.now, place, country) : null;
    if (o && !seen.has(o.id)) {
      seen.add(o.id);
      out.push(o);
    }
  }
  return out;
}

/** SAWk as a `Source`, so `runSources` applies the daily cap, the 401/403/429 stop and the call record. */
export const sawk: Source = {
  name: "sawk",
  kinds: ["event"],
  paid: false,
  dailyCap: 200, // our ceiling; a call reads one person's own feed
  enabled: (env) => sawkConfigured(env),
  why_disabled: (env) => sawkWhyDisabled(env),
  async search(q: SourceQuery, ctx: SearchContext) {
    if (q.kind !== "events") return [];
    return sawkEvents(q.place, q.country, q.window, { env: ctx.env, fetch: ctx.fetch, signal: ctx.signal, now: ctx.now });
  },
};
