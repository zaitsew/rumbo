import { describe, expect, it } from "vitest";
import { ProfileSchema, WatchSchema, type Observation } from "../src/core/schema";
import { ALL_SOURCES, createMemoryLedger, describeSources, queriesForWatch, runSources } from "../src/server/sources";
import { formatMinor, minorExponent, SourceError, toMinor } from "../src/server/sources/http";
import { offsetLegs, timeZoneFor, withOffset } from "../src/server/sources/time";
import type { Source, SourceQuery } from "../src/server/sources/types";
import { flightsVlcLis, NOW } from "./sources-helpers";

const profile = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC", "ALC"], currency: "EUR", travellers: { adults: 2 } });

function flight(id: string, cents: number, source = "x"): Observation {
  return {
    kind: "flight", id, title: "t", place: "Lisbon", tags: [],
    provenance: { source, seen_at: NOW.toISOString() },
    origin: "VLC", destination: "LIS", depart_date: "2026-12-06", price: { amount_minor: cents, currency: "EUR" }, stops: 0, legs: [],
  };
}

function fake(over: Partial<Source> & { name: string }): Source {
  return { kinds: ["flight"], paid: false, dailyCap: 5, enabled: () => true, why_disabled: () => null, search: async () => [], ...over };
}

describe("runSources", () => {
  it("skips disabled sources with their reason and runs the others", async () => {
    const off = fake({ name: "off", enabled: () => false, why_disabled: () => "set OFF_KEY" });
    const on = fake({ name: "on", search: async () => [flight("a", 100)] });
    const r = await runSources([flightsVlcLis], { sources: [off, on], ledger: createMemoryLedger(), env: {}, now: NOW });
    expect(r.observations.map((o) => o.id)).toEqual(["a"]);
    expect(r.calls).toEqual([
      { source: "off", n: 0, ok: false, skipped: "disabled", error: "set OFF_KEY" },
      { source: "on", n: 1, ok: true },
    ]);
  });

  it("does not call a source for a kind it does not serve", async () => {
    let called = 0;
    const s = fake({ name: "flightsOnly", search: async () => { called++; return []; } });
    const q: SourceQuery = { kind: "events", place: "Valencia", window: { from: "2026-12-01", to: "2026-12-02" } };
    const r = await runSources([q], { sources: [s], ledger: createMemoryLedger(), env: {}, now: NOW });
    expect(called).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("counts calls before making them and stops at the daily cap", async () => {
    const ledger = createMemoryLedger();
    const seenCount: number[] = [];
    const s = fake({ name: "capped", dailyCap: 3, search: async () => { seenCount.push(ledger.count("capped", "2026-10-23")); return []; } });
    const qs = Array.from({ length: 5 }, () => flightsVlcLis);
    const r = await runSources(qs, { sources: [s], ledger, env: {}, now: NOW });
    expect(seenCount).toEqual([1, 2, 3]); // already charged when the call runs
    expect(ledger.count("capped", "2026-10-23")).toBe(3);
    expect(r.calls.filter((c) => c.ok)).toHaveLength(3);
    expect(r.calls.filter((c) => c.skipped === "cap")).toHaveLength(2);
    expect(r.calls.at(-1)?.error).toMatch(/daily cap 3 reached/);
  });

  it("holds the cap across runs and resets it the next day", async () => {
    const ledger = createMemoryLedger();
    const s = fake({ name: "c", dailyCap: 2 });
    const opts = { sources: [s], ledger, env: {} };
    await runSources([flightsVlcLis, flightsVlcLis], { ...opts, now: NOW });
    const again = await runSources([flightsVlcLis], { ...opts, now: new Date("2026-10-23T22:00:00Z") });
    expect(again.calls[0]).toMatchObject({ skipped: "cap", n: 0 });
    const tomorrow = await runSources([flightsVlcLis], { ...opts, now: new Date("2026-10-24T00:30:00Z") });
    expect(tomorrow.calls[0]).toMatchObject({ ok: true, n: 1 });
  });

  it("charges what callsFor says, and skips a query that does not fit", async () => {
    const ledger = createMemoryLedger();
    const s = fake({ name: "multi", dailyCap: 5, callsFor: () => 3 });
    const r = await runSources([flightsVlcLis, flightsVlcLis], { sources: [s], ledger, env: {}, now: NOW });
    expect(r.calls.map((c) => [c.n, c.skipped])).toEqual([[3, undefined], [0, "cap"]]);
    expect(ledger.count("multi", "2026-10-23")).toBe(3);
  });

  it("catches one source's error and keeps the rest, and still charges the call", async () => {
    const ledger = createMemoryLedger();
    const bad = fake({ name: "bad", search: async () => { throw new Error("boom"); } });
    const good = fake({ name: "good", search: async () => [flight("g", 5)] });
    const r = await runSources([flightsVlcLis], { sources: [bad, good], ledger, env: {}, now: NOW });
    expect(r.calls).toEqual([{ source: "bad", n: 1, ok: false, error: "boom" }, { source: "good", n: 1, ok: true }]);
    expect(r.observations).toHaveLength(1);
    expect(ledger.count("bad", "2026-10-23")).toBe(1);
  });

  it("stops a source after HTTP 429 or 401 instead of burning its cap", async () => {
    let n = 0;
    const s = fake({ name: "limited", dailyCap: 10, search: async () => { n++; throw new SourceError("host/x: HTTP 429", 429); } });
    const r = await runSources([flightsVlcLis, flightsVlcLis, flightsVlcLis], { sources: [s], ledger: createMemoryLedger(), env: {}, now: NOW });
    expect(n).toBe(1);
    expect(r.calls).toHaveLength(3);
    expect(r.calls[1]!.error).toMatch(/skipped after/);
  });

  it("keeps the cheapest copy of the same offer seen by two sources", async () => {
    const a = fake({ name: "a", search: async () => [flight("same", 9000, "a"), flight("only-a", 100, "a")] });
    const b = fake({ name: "b", search: async () => [flight("same", 8000, "b")] });
    const r = await runSources([flightsVlcLis], { sources: [a, b], ledger: createMemoryLedger(), env: {}, now: NOW });
    expect(r.observations).toHaveLength(2);
    const same = r.observations.find((o) => o.id === "same")!;
    expect(same.provenance.source).toBe("b");
  });

  it("drops invalid observations and says so", async () => {
    const s = fake({ name: "sloppy", search: async () => [flight("ok", 1), { ...flight("bad", 1), depart_date: "tomorrow" } as Observation] });
    const r = await runSources([flightsVlcLis], { sources: [s], ledger: createMemoryLedger(), env: {}, now: NOW });
    expect(r.observations.map((o) => o.id)).toEqual(["ok"]);
    expect(r.calls[0]).toMatchObject({ ok: true, error: "dropped 1 invalid observation(s)" });
  });

  it("passes env, fetch and an abort signal to the source", async () => {
    let seen: any;
    const f = (async () => new Response("{}")) as typeof fetch;
    const s = fake({ name: "ctx", search: async (_q, ctx) => { seen = ctx; return []; } });
    await runSources([flightsVlcLis], { sources: [s], ledger: createMemoryLedger(), env: { A: "1" }, now: NOW, fetch: f });
    expect(seen.env).toEqual({ A: "1" });
    expect(seen.fetch).toBe(f);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("registry", () => {
  it("lists seven sources, free before paid, with caps", () => {
    expect(ALL_SOURCES.map((s) => s.name)).toEqual(["kiwi-mcp", "travelpayouts", "viator", "tiqets", "liteapi", "duffel"]);
    expect(ALL_SOURCES.filter((s) => s.paid).map((s) => s.name)).toEqual(["liteapi", "duffel"]);
    expect(ALL_SOURCES.find((s) => s.name === "kiwi-mcp")!.dailyCap).toBe(60);
  });

  it("with an empty environment only Kiwi runs, and every other source says what to set", () => {
    const d = describeSources({});
    expect(d.filter((s) => s.enabled).map((s) => s.name)).toEqual(["kiwi-mcp"]);
    for (const s of d.filter((x) => !x.enabled)) expect(s.why_disabled).toMatch(/[A-Z]{4,}_/);
  });

  it("never enables a paid source from the key alone", () => {
    const d = describeSources({ LITEAPI_KEY: "k", DUFFEL_TOKEN: "t" });
    expect(d.filter((s) => s.paid).every((s) => !s.enabled)).toBe(true);
    const on = describeSources({ LITEAPI_KEY: "k", DUFFEL_TOKEN: "t", RUMBO_ALLOW_PAID_LITEAPI: "1", RUMBO_ALLOW_PAID_DUFFEL: "1" });
    expect(on.filter((s) => s.paid).every((s) => s.enabled)).toBe(true);
  });
});

describe("queriesForWatch", () => {
  const base = { id: "w1", label: "x", window: { from: "2026-12-04", to: "2026-12-06" } };

  it("route: uses the watch's airports or the profile's, with profile travellers and limits", () => {
    const w = WatchSchema.parse({ ...base, kind: "route", destination: ["LIS"], nights: { min: 3, max: 4 } });
    expect(queriesForWatch(w, profile)).toEqual([
      { kind: "flights", origin: ["VLC", "ALC"], destination: ["LIS"], window: base.window, nights: { min: 3, max: 4 }, adults: 2, children: 0, child_ages: [], currency: "EUR", max_stops: 1 },
    ]);
    const own = WatchSchema.parse({ ...base, kind: "route", origin: ["MAD"], destination: ["LIS"] });
    expect((queriesForWatch(own, profile)[0] as any).origin).toEqual(["MAD"]);
    expect(queriesForWatch(WatchSchema.parse({ ...base, kind: "route" }), profile)).toEqual([]);
  });

  it("carries the profile's children into flights and stays, with age 8 when unknown", () => {
    const fam = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], currency: "EUR", travellers: { adults: 2, children: 2 } });
    const f = queriesForWatch(WatchSchema.parse({ ...base, kind: "route", destination: ["LIS"] }), fam)[0] as any;
    expect(f).toMatchObject({ adults: 2, children: 2, child_ages: [8, 8] });
    const a = queriesForWatch(WatchSchema.parse({ ...base, kind: "anywhere" }), fam)[0] as any;
    expect(a).toMatchObject({ children: 2, child_ages: [8, 8] });
    const st = queriesForWatch(WatchSchema.parse({ ...base, kind: "place-stays", place: "Lisbon" }), fam)[0] as any;
    expect(st).toMatchObject({ kind: "stays", adults: 2, children: 2, child_ages: [8, 8] });
  });

  it("anywhere: destination 'anywhere'", () => {
    const q = queriesForWatch(WatchSchema.parse({ ...base, kind: "anywhere" }), profile)[0] as any;
    expect(q).toMatchObject({ kind: "flights", destination: "anywhere", origin: ["VLC", "ALC"] });
  });

  it("place watches: events, stays, activities", () => {
    expect(queriesForWatch(WatchSchema.parse({ ...base, kind: "place-events", place: "Lisbon" }), profile)).toEqual([
      { kind: "events", place: "Lisbon", country: "PT", window: base.window },
    ]);
    expect(queriesForWatch(WatchSchema.parse({ ...base, kind: "place-stays", place: "Lisbon", nights: { min: 3, max: 5 } }), profile)).toEqual([
      { kind: "stays", place: "Lisbon", country: "PT", check_in: "2026-12-04", check_out: "2026-12-07", adults: 2, children: 0, child_ages: [], currency: "EUR" },
    ]);
    expect(queriesForWatch(WatchSchema.parse({ ...base, kind: "place-activities", place: "Lisbon" }), profile)).toEqual([
      { kind: "activities", place: "Lisbon", country: "PT", date: undefined, currency: "EUR" },
    ]);
    expect(queriesForWatch(WatchSchema.parse({ ...base, kind: "place-events" }), profile)).toEqual([]);
  });
});

describe("withOffset", () => {
  it("attaches the right offset across daylight saving", () => {
    expect(withOffset("2026-12-06T05:55:00", "Europe/Madrid")).toBe("2026-12-06T05:55:00+01:00");
    expect(withOffset("2026-07-06T05:55:00", "Europe/Madrid")).toBe("2026-07-06T05:55:00+02:00");
    expect(withOffset("2026-12-06T06:40:00", "Europe/Lisbon")).toBe("2026-12-06T06:40:00+00:00");
    expect(withOffset("2026-12-06T06:40", "Asia/Kolkata")).toBe("2026-12-06T06:40:00+05:30");
    expect(withOffset("2026-12-06T06:40:00+01:00", "UTC")).toBe("2026-12-06T06:40:00+01:00");
    expect(withOffset("2026-12-06T06:40:00", "Not/AZone")).toBeUndefined();
    expect(withOffset("2026-12-06T06:40:00", undefined)).toBeUndefined();
  });

  it("does not guess a zone for unknown airports or multi-zone countries", () => {
    expect(timeZoneFor("XXX", "Narnia")).toBeUndefined();
    expect(timeZoneFor("DEN", "United States")).toBe("America/Denver");
    expect(timeZoneFor("PHX", "United States")).toBeUndefined();
    expect(timeZoneFor("VLC", "Spain")).toBe("Europe/Madrid");
    expect(timeZoneFor("TFS", "Spain")).toBe("Atlantic/Canary");
  });

  it("offsetLegs returns nothing when a zone is unknown or contradicts the flight time", () => {
    const seg = { from: "VLC", to: "LIS", departLocal: "2026-12-06T05:55:00", arriveLocal: "2026-12-06T06:40:00", durationMin: 105, tzFrom: "Europe/Madrid", tzTo: "Europe/Lisbon", carrier: "TP", flight_no: "TP1097" };
    expect(offsetLegs([seg])).toHaveLength(1);
    expect(offsetLegs([{ ...seg, tzTo: undefined }])).toBeUndefined();
    expect(offsetLegs([{ ...seg, tzTo: "Asia/Tokyo" }])).toBeUndefined();
  });
});

describe("money in minor units", () => {
  it("uses the ISO 4217 exponent", () => {
    expect(minorExponent("EUR")).toBe(2);
    expect(minorExponent("JPY")).toBe(0);
    expect(minorExponent("KWD")).toBe(3);
    expect(minorExponent("BHD")).toBe(3);
    expect(toMinor(36.9, "EUR")).toBe(3690);
    expect(toMinor("12345", "JPY")).toBe(12345);
    expect(toMinor(12.345, "KWD")).toBe(12345);
    expect(toMinor("1.250", "BHD")).toBe(1250);
    expect(formatMinor(12345, "JPY")).toBe("12345");
    expect(formatMinor(12345, "KWD")).toBe("12.345");
    expect(formatMinor(3690, "EUR")).toBe("36.90");
  });
});
