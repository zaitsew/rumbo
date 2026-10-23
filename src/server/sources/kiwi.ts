import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ObservationSchema, type Observation } from "../../core/schema";
import { flightId, flightNo, legKey } from "./id";
import { SourceError, addHours, toMinor } from "./http";
import { offsetLegs, timeZoneFor, type LocalSegment } from "./time";
import { childAges, type Env, type SearchContext, type Source, type SourceQuery } from "./types";

/**
 * Kiwi.com public MCP server, https://mcp.kiwi.com, no key. One tool, `search-flight`; its listing is
 * recorded in tests/fixtures/sources/kiwi-tools.json and the input schema below follows it.
 *
 * Terms (docs/SOURCES.md): Kiwi's MCP page and website terms do not mention scheduled or programmatic
 * use either way; the website terms forbid "commercial use" and software that "interferes" with the
 * site. Rumbo is a personal, non-commercial tool and stays under 60 calls a day, so the adapter is on by
 * default. `RUMBO_KIWI_MCP=0` turns it off.
 */
export const KIWI_MCP_URL = "https://mcp.kiwi.com";
export const KIWI_TOOL = "search-flight";
const MAX_RESULTS = 20;
/** Kiwi quotes live prices; we treat one as good for six hours (unverified: the tool states no expiry). */
const PRICE_TTL_HOURS = 6;

export type KiwiCallTool = (args: Record<string, unknown>, ctx: SearchContext) => Promise<unknown>;

/** The MCP result of `search-flight`: `structuredContent` when present, else the JSON text block. */
interface KiwiSegment {
  from: string; to: string; fromCity?: string; toCity?: string; fromCountry?: string; toCountry?: string;
  departureTime: string; arrivalTime: string; durationSeconds?: number; carrier?: string; carrierName?: string; flightNumber?: string;
}
interface KiwiLeg {
  from: string; to: string; departureTime: string; arrivalTime: string; durationSeconds?: number; stops: number;
  segments: KiwiSegment[];
}
interface KiwiItinerary {
  id?: string; price: number | null; priceFormatted?: string; bookingUrl?: string; totalDurationSeconds?: number;
  outbound: KiwiLeg; inbound?: KiwiLeg;
}
export interface KiwiResult {
  query?: string; currency?: string | null; passengers?: { adults: number; children: number; infants: number } | null;
  resultsCount?: number; itineraries?: KiwiItinerary[]; error?: string | null;
}

const ddmmyyyy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Query → arguments of `search-flight`. Comma-separated IATA lists and "anywhere" were checked live on 2026-10-23. */
export function kiwiArguments(q: Extract<SourceQuery, { kind: "flights" }>, now: Date): Record<string, unknown> {
  const today = now.toISOString().slice(0, 10);
  const from = q.window.from < today ? today : q.window.from;
  const to = q.window.to < from ? from : q.window.to;
  const anywhere = q.destination === "anywhere";
  const args: Record<string, unknown> = {
    flyFrom: q.origin.join(","),
    flyTo: anywhere ? "anywhere" : (q.destination as string[]).join(","),
    departureDate: ddmmyyyy(from),
    adults: q.adults,
    currency: q.currency,
    sort: "price",
  };
  // Kiwi takes children aged 2-11 as a count; it has no per-child age.
  const kids = childAges(q).filter((a) => a >= 2 && a <= 11).length;
  if (kids) args.children = kids;
  if (to !== from) args.departureDateTo = ddmmyyyy(to);
  if (q.nights) {
    args.nights_in_dst_from = q.nights.min;
    args.nights_in_dst_to = q.nights.max;
  }
  if (anywhere) args.one_for_city = true;
  if (q.max_stops !== undefined) args.max_sector_stopovers = q.max_stops;
  return args;
}

export function parseKiwiResult(raw: unknown): KiwiResult {
  const r = raw as { structuredContent?: KiwiResult; content?: { type: string; text?: string }[]; isError?: boolean };
  if (r?.structuredContent) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new SourceError("kiwi-mcp: empty tool result");
  try {
    return JSON.parse(text) as KiwiResult;
  } catch {
    // The tool reports failures as plain text.
    throw new SourceError(`kiwi-mcp: ${text.slice(0, 200)}`);
  }
}

export function mapKiwi(result: KiwiResult, q: Extract<SourceQuery, { kind: "flights" }>, now: Date): Observation[] {
  if (result.error) throw new SourceError(`kiwi-mcp: ${result.error}`);
  const currency = (result.currency ?? q.currency).toUpperCase();
  // `price` covers all passengers; the schema wants a price per person.
  const pax = Math.max(1, (result.passengers?.adults ?? q.adults) + (result.passengers?.children ?? 0));
  const seenAt = now.toISOString();
  const expiresAt = addHours(now, PRICE_TTL_HOURS);
  const byId = new Map<string, Observation>();

  for (const it of result.itineraries ?? []) {
    if (it.price == null || !it.outbound?.segments?.length) continue;
    const out = it.outbound;
    const last = out.segments[out.segments.length - 1]!;
    // Kiwi's times are local with no offset and no UTC twin. Offsets come only from a zone we are sure of,
    // cross-checked against the segment's own duration; otherwise `legs` stays empty.
    const localSegs = (leg: KiwiLeg | undefined): LocalSegment[] =>
      (leg?.segments ?? []).map((s) => ({
        from: s.from, to: s.to, departLocal: s.departureTime, arriveLocal: s.arrivalTime,
        durationMin: s.durationSeconds ? s.durationSeconds / 60 : undefined,
        tzFrom: timeZoneFor(s.from, s.fromCountry), tzTo: timeZoneFor(s.to, s.toCountry),
        carrier: s.carrierName ?? s.carrier ?? "", flight_no: flightNo(s.carrier, s.flightNumber) || undefined,
      }));
    const allSegs = [...(out.segments ?? []), ...(it.inbound?.segments ?? [])];
    const legKeys = allSegs.map((s) => legKey({ carrier: s.carrier, number: s.flightNumber, from: s.from, to: s.to, departLocal: s.departureTime }));
    const depart_date = out.departureTime.slice(0, 10);
    const return_date = it.inbound?.departureTime.slice(0, 10);
    const place = last.toCity ?? last.to;
    const obs: Observation = {
      kind: "flight",
      id: flightId({ origin: out.from, destination: out.to, depart_date, return_date, legs: legKeys }),
      provenance: { source: "kiwi-mcp", url: it.bookingUrl, seen_at: seenAt, expires_at: expiresAt },
      title: `${out.from} → ${place}, ${depart_date}${return_date ? ` – ${return_date}` : ""}`,
      place,
      country: last.toCountry,
      tags: [],
      book_url: it.bookingUrl,
      origin: out.from,
      destination: out.to,
      depart_date,
      return_date,
      price: { amount_minor: Math.round(toMinor(it.price, currency) / pax), currency },
      stops: Math.max(out.stops, it.inbound?.stops ?? 0),
      duration_minutes: out.durationSeconds ? Math.round(out.durationSeconds / 60) : undefined,
      legs: offsetLegs([...localSegs(out), ...localSegs(it.inbound)]) ?? [],
      seller: "Kiwi.com",
    };
    // The id covers every leg, so a repeat means the same itinerary listed twice; keep the cheapest.
    const prev = byId.get(obs.id);
    if (!prev || (prev.kind === "flight" && obs.kind === "flight" && obs.price.amount_minor < prev.price.amount_minor)) byId.set(obs.id, obs);
  }
  return [...byId.values()].slice(0, MAX_RESULTS).map((o) => ObservationSchema.parse(o));
}

/** The real transport: one short MCP session per search, closed afterwards. */
export const mcpCallTool: KiwiCallTool = async (args, ctx) => {
  const client = new Client({ name: "rumbo", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(KIWI_MCP_URL), { fetch: ctx.fetch });
  try {
    await client.connect(transport);
    return await client.callTool({ name: KIWI_TOOL, arguments: args }, undefined, { signal: ctx.signal });
  } catch (e) {
    throw new SourceError(`kiwi-mcp: ${(e as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
  }
};

export function createKiwiSource(callTool: KiwiCallTool = mcpCallTool): Source {
  return {
    name: "kiwi-mcp",
    kinds: ["flight"],
    paid: false,
    dailyCap: 60,
    enabled: (env: Env) => env.RUMBO_KIWI_MCP !== "0",
    why_disabled: (env: Env) => (env.RUMBO_KIWI_MCP === "0" ? "RUMBO_KIWI_MCP=0 switches the Kiwi MCP off; unset it to enable" : null),
    async search(q, ctx) {
      if (q.kind !== "flights") return [];
      const raw = await callTool(kiwiArguments(q, ctx.now), ctx);
      return mapKiwi(parseKiwiResult(raw), q, ctx.now);
    },
  };
}

export const kiwi = createKiwiSource();
