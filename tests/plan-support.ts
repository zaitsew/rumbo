import { DestinationSchema, type Destination } from "../src/core/destinations";
import type { Observation } from "../src/core/schema";
import type { CallLedger, Env, SearchContext, Source, SourceQuery } from "../src/server/sources/types";

export const NOW = new Date("2026-10-23T08:00:00Z");

export function dest(over: Record<string, unknown>): Destination {
  return DestinationSchema.parse({
    country: "Portugal",
    tags: ["city"],
    best_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    flight_hours_from: { VLC: 2.5, MAD: 2, BCN: 2.5 },
    cost_level: 2,
    ...over,
  });
}

/** A small pool, so which places a request picks is easy to follow. */
export const POOL: Destination[] = [
  dest({ place: "Lisbon", country: "Portugal", airports: ["LIS"], tags: ["city", "food", "surf"] }),
  dest({ place: "Tarifa", country: "Spain", airports: ["XRY", "AGP"], tags: ["kitesurf", "beach"], flight_hours_from: { VLC: 2, MAD: 2, BCN: 2.5 } }),
  dest({ place: "Rome", country: "Italy", airports: ["FCO"], tags: ["city", "culture", "food"], flight_hours_from: { VLC: 2.2, MAD: 2.8, BCN: 2 } }),
  dest({ place: "Prague", country: "Czechia", airports: ["PRG"], tags: ["city", "culture", "nightlife"], flight_hours_from: { VLC: 3.2, MAD: 3.5, BCN: 2.8 } }),
  dest({ place: "Madeira", country: "Portugal", airports: ["FNC"], tags: ["hiking", "nature", "beach"], flight_hours_from: { VLC: 3.5, MAD: 3, BCN: 4 } }),
  dest({ place: "Dakhla", country: "Morocco", airports: ["VIL"], tags: ["kitesurf", "beach"], flight_hours_from: { VLC: 5, MAD: 4.5, BCN: 5.5 } }),
];

export const FARE_MINOR: Record<string, number> = { LIS: 8900, XRY: 4900, AGP: 5600, FCO: 12000, PRG: 9900, FNC: 15000, VIL: 18000 };
const PLACE: Record<string, string> = { LIS: "Lisbon", XRY: "Tarifa", AGP: "Tarifa", FCO: "Rome", PRG: "Prague", FNC: "Madeira", VIL: "Dakhla" };

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plus = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

export interface Calls { queries: SourceQuery[] }

export function fakeSource(opts: {
  name: string;
  kinds: Source["kinds"];
  enabled?: boolean;
  callsFor?: number;
  dailyCap?: number;
  search: (q: SourceQuery, ctx: SearchContext) => Observation[] | Promise<Observation[]>;
}): Source & Calls {
  const queries: SourceQuery[] = [];
  const on = opts.enabled ?? true;
  return {
    name: opts.name,
    kinds: opts.kinds,
    paid: false,
    dailyCap: opts.dailyCap ?? 100,
    enabled: (_env: Env) => on,
    why_disabled: () => (on ? null : `${opts.name.toUpperCase()}_KEY is not set`),
    callsFor: () => opts.callsFor ?? 1,
    async search(q, ctx) {
      queries.push(q);
      return opts.search(q, ctx);
    },
    queries,
  };
}

/** Flights to every destination airport asked, each leaving on the first day of the window. */
export function fakeFlights(name = "fake-fares", extra: Partial<Parameters<typeof fakeSource>[0]> = {}) {
  return fakeSource({
    name,
    kinds: ["flight"],
    ...extra,
    search(q, ctx) {
      if (q.kind !== "flights" || q.destination === "anywhere") return [];
      const nights = q.nights?.min ?? 3;
      return q.destination.map((iata): Observation => {
        const depart = q.window.from;
        const ret = addDays(depart, nights);
        return {
          kind: "flight",
          id: `fl_${iata}_${depart}_${ret}`,
          title: `${q.origin[0]} to ${PLACE[iata] ?? iata}`,
          place: PLACE[iata] ?? iata,
          tags: [],
          provenance: { source: name, seen_at: ctx.now.toISOString(), expires_at: plus(ctx.now, 6) },
          origin: q.origin[0]!,
          destination: iata,
          depart_date: depart,
          return_date: ret,
          price: { amount_minor: FARE_MINOR[iata] ?? 20000, currency: "EUR" },
          stops: 0,
          legs: [],
          book_url: `https://example.test/book/${iata}`,
        };
      });
    },
  });
}

export function fakeStays(name = "fake-stays", extra: Partial<Parameters<typeof fakeSource>[0]> = {}) {
  return fakeSource({
    name,
    kinds: ["stay"],
    ...extra,
    search(q, ctx) {
      if (q.kind !== "stays") return [];
      return [140, 90, 210].map((eur, i): Observation => ({
        kind: "stay",
        id: `st_${q.place}_${i}`,
        title: `Hotel ${i + 1}, ${q.place}`,
        place: q.place,
        tags: [],
        provenance: { source: name, seen_at: ctx.now.toISOString(), expires_at: plus(ctx.now, 6) },
        check_in: q.check_in,
        check_out: q.check_out,
        price_total: { amount_minor: eur * 100, currency: "EUR" },
        rating: 8 - i * 0.5,
        name: `Hotel ${i + 1}`,
        book_url: `https://example.test/stay/${i}`,
      }));
    },
  });
}

export function fakeActivities(name = "fake-acts", extra: Partial<Parameters<typeof fakeSource>[0]> = {}) {
  return fakeSource({
    name,
    kinds: ["activity"],
    ...extra,
    search(q, ctx) {
      if (q.kind !== "activities") return [];
      return [2500, 4000].map((minor, i): Observation => ({
        kind: "activity",
        id: `ac_${q.place}_${i}`,
        title: `Tour ${i + 1} in ${q.place}`,
        place: q.place,
        tags: [],
        provenance: { source: name, seen_at: ctx.now.toISOString(), expires_at: plus(ctx.now, 24) },
        price: { amount_minor: minor, currency: "EUR" },
        rating: 4.5,
        book_url: `https://example.test/act/${i}`,
      }));
    },
  });
}

export function fakeEvents(name = "fake-events", extra: Partial<Parameters<typeof fakeSource>[0]> = {}) {
  return fakeSource({
    name,
    kinds: ["event"],
    ...extra,
    search(q, ctx) {
      if (q.kind !== "events") return [];
      return [
        {
          kind: "event",
          id: `ev_${q.place}_1`,
          title: `Concert in ${q.place}`,
          place: q.place,
          tags: ["concerts"],
          provenance: { source: name, seen_at: ctx.now.toISOString(), expires_at: plus(ctx.now, 24 * 60) },
          date: q.window.from,
          venue: "Main hall",
        },
        {
          kind: "event",
          id: `ev_${q.place}_far`,
          title: "Too late",
          place: q.place,
          tags: [],
          provenance: { source: name, seen_at: ctx.now.toISOString() },
          date: "2027-06-01",
        },
      ];
    },
  });
}

export function memoryLedger(): CallLedger & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    count: (s, d) => map.get(`${s}|${d}`) ?? 0,
    add: (s, d, n) => map.set(`${s}|${d}`, (map.get(`${s}|${d}`) ?? 0) + n),
  };
}
