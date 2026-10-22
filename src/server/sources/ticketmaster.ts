import { ObservationSchema, type Interest, type Observation } from "../../core/schema";
import { observationId, norm } from "./id";
import { SourceError, requestJson, toMinor } from "./http";
import type { Env, Source, SourceQuery } from "./types";

/**
 * Ticketmaster Discovery API v2, events by city and date window. Free key, 5,000 calls a day and 5 a
 * second (developer.ticketmaster.com). Terms: no caching of Event Content "other than for reasonable
 * periods"; Rumbo keeps a row until the event has happened and re-reads it on every run.
 * The key travels in the query string (`apikey`), as the API requires; errors never print it.
 */
export const TM_BASE = "https://app.ticketmaster.com/discovery/v2/events.json";
const PAGE_SIZE = 100;

interface TmClassification { segment?: { name?: string }; genre?: { name?: string }; subGenre?: { name?: string }; type?: { name?: string }; subType?: { name?: string } }
interface TmEvent {
  id: string; name: string; url?: string;
  dates?: { start?: { localDate?: string; dateTime?: string }; end?: { localDate?: string }; status?: { code?: string } };
  priceRanges?: { type?: string; currency?: string; min?: number; max?: number }[];
  classifications?: TmClassification[];
  _embedded?: { venues?: { name?: string; city?: { name?: string }; country?: { countryCode?: string } }[] };
}
export interface TmResponse { _embedded?: { events?: TmEvent[] }; page?: { totalElements?: number }; fault?: { faultstring?: string } }

type EventQuery = Extract<SourceQuery, { kind: "events" }>;

export function tagsOf(e: TmEvent): Interest[] {
  const tags = new Set<Interest>();
  for (const c of e.classifications ?? []) {
    const seg = norm(c.segment?.name);
    if (seg === "music") tags.add("concerts");
    else if (seg === "sports") tags.add("sport-events");
    else if (seg.startsWith("arts") || seg === "film") tags.add("culture");
    const all = [c.genre?.name, c.subGenre?.name, c.type?.name, c.subType?.name, e.name].map(norm).join(" ");
    if (/\bfestival\b/.test(all)) tags.add("festivals");
  }
  return [...tags];
}

export function requestUrl(q: EventQuery, apikey: string): string {
  const u = new URL(TM_BASE);
  u.searchParams.set("apikey", apikey);
  u.searchParams.set("city", q.place);
  if (q.country) u.searchParams.set("countryCode", q.country.toUpperCase());
  u.searchParams.set("startDateTime", `${q.window.from}T00:00:00Z`);
  u.searchParams.set("endDateTime", `${q.window.to}T23:59:59Z`);
  u.searchParams.set("sort", "date,asc");
  u.searchParams.set("size", String(PAGE_SIZE));
  return u.toString();
}

export function mapTicketmaster(res: TmResponse, q: EventQuery, now: Date): Observation[] {
  if (res.fault) throw new SourceError(`ticketmaster: ${res.fault.faultstring ?? "fault"}`);
  const seenAt = now.toISOString();
  const out: Observation[] = [];
  for (const e of res._embedded?.events ?? []) {
    const date = e.dates?.start?.localDate;
    const status = e.dates?.status?.code;
    if (!date || status === "cancelled" || status === "canceled") continue;
    const venue = e._embedded?.venues?.[0];
    const price = e.priceRanges?.find((p) => typeof p.min === "number" && p.currency);
    const endDate = e.dates?.end?.localDate;
    out.push(ObservationSchema.parse({
      kind: "event",
      id: observationId("event", e.name, q.place, date, venue?.name),
      provenance: {
        source: "ticketmaster", url: e.url, seen_at: seenAt,
        // The event is stale once it has happened.
        expires_at: e.dates?.start?.dateTime ?? `${endDate ?? date}T23:59:59Z`,
      },
      title: e.name,
      place: q.place,
      country: venue?.country?.countryCode ?? q.country,
      tags: tagsOf(e),
      book_url: e.url,
      date,
      end_date: endDate && endDate !== date ? endDate : undefined,
      venue: venue?.name,
      price_from: price ? { amount_minor: toMinor(price.min!), currency: price.currency!.toUpperCase() } : undefined,
    }));
  }
  return out;
}

export const ticketmaster: Source = {
  name: "ticketmaster",
  kinds: ["event"],
  paid: false,
  dailyCap: 1000, // the key allows 5,000; we stay well under
  enabled: (env: Env) => Boolean(env.TICKETMASTER_API_KEY),
  why_disabled: (env: Env) => (env.TICKETMASTER_API_KEY ? null : "set TICKETMASTER_API_KEY (free, developer.ticketmaster.com)"),
  async search(q, ctx) {
    if (q.kind !== "events") return [];
    const key = (ctx.env ?? process.env).TICKETMASTER_API_KEY;
    if (!key) throw new SourceError("ticketmaster: TICKETMASTER_API_KEY is not set");
    const res = await requestJson<TmResponse>(ctx, { url: requestUrl(q, key) });
    return mapTicketmaster(res, q, ctx.now);
  },
};
