/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { DestinationSchema, hoursFromHome, planDestinations, type Destination } from "../src/core/destinations";
import { DestinationCandidateSchema, PlanRequestSchema, ProfileSchema, type PastTrip } from "../src/core/schema";

const DIR = join(__dirname, "..", "data", "destinations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();
const pool: Destination[] = files.map((f) => DestinationSchema.parse(parse(readFileSync(join(DIR, f), "utf8"))));

const profile = ProfileSchema.parse({
  home_city: "Valencia", home_airports: ["VLC", "ALC", "MAD", "BCN"],
  interests: { kitesurf: 2, beach: 1, food: 2, nightlife: -2 },
  flight: { max_hours_one_way: 8 }, wishlist: ["Madeira"],
});
const req = (over: Record<string, unknown> = {}) =>
  PlanRequestSchema.parse({ window: { from: "2026-12-04", to: "2026-12-12" }, nights: { min: 3, max: 5 }, ...over });
const top = (c: { place: string }[], n = 10) => c.slice(0, n).map((x) => x.place);

describe("data/destinations", () => {
  it("holds 60 to 80 files, each a valid destination named by its slug", () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(files.length).toBeLessThanOrEqual(80);
    for (const f of files) {
      const d = DestinationSchema.parse(parse(readFileSync(join(DIR, f), "utf8")));
      const slug = d.place.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      expect(f, f).toBe(`${slug}.yaml`);
    }
  });

  it("has no duplicate places and no price fields", () => {
    expect(new Set(pool.map((d) => d.place)).size).toBe(pool.length);
    for (const f of files) expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(/price|€|\$|£|\bEUR\b|\bUSD\b/i);
  });

  it("covers the spread an owner in Valencia needs", () => {
    const has = (p: string) => pool.some((d) => d.place === p);
    for (const p of ["Tarifa", "Fuerteventura", "Lanzarote", "Tenerife", "Sierra Nevada", "Andorra", "Lisbon", "Porto", "Madeira", "Rome", "Paris", "Athens", "Dubrovnik", "Marrakech", "Copenhagen", "Prague", "New York", "Mexico City", "Tokyo", "Bali", "Cape Town", "Dahab", "Zanzibar"]) {
      expect(has(p), p).toBe(true);
    }
    expect(new Set(pool.map((d) => d.country)).size).toBeGreaterThanOrEqual(25);
    expect(pool.some((d) => d.airports.includes("GVA"))).toBe(true);
    expect(pool.some((d) => d.airports.includes("TRN"))).toBe(true);
    expect(pool.some((d) => d.airports.includes("INN"))).toBe(true);
  });

  it("only estimates hours from VLC, MAD and BCN", () => {
    expect(DestinationSchema.safeParse({ ...pool[0], flight_hours_from: { LIS: 2 } }).success).toBe(false);
  });
});

describe("planDestinations", () => {
  it("ranks winter sun and kitesurf first when asked for kitesurf in December", () => {
    const out = planDestinations(req({ interests: ["kitesurf"] }), profile, [], pool);
    expect(top(out, 8)).toEqual(expect.arrayContaining(["Fuerteventura"]));
    expect(top(out, 3).every((p) => ["Fuerteventura", "Tenerife", "Gran Canaria", "Lanzarote", "Dakhla", "Zanzibar", "Cape Town", "Dahab", "Tarifa", "Essaouira"].includes(p))).toBe(true);
    const f = out.find((c) => c.place === "Fuerteventura")!;
    expect(f.reasons).toContain("has kitesurf, which you asked for");
    expect(f.reasons).toContain("in season in Dec");
    expect(f.reasons.some((r) => /^about [\d.]+ h from (VLC|MAD|BCN) \(approximate\)$/.test(r))).toBe(true);
  });

  it("puts ski resorts ahead in winter and behind in summer when skiing is asked for", () => {
    const winter = planDestinations(req({ interests: ["ski"] }), profile, [], pool);
    expect(top(winter, 5).some((p) => ["Sierra Nevada", "Andorra", "Chamonix", "Val Thorens", "Courmayeur", "St Anton am Arlberg", "Zermatt", "Sestriere", "Cortina d'Ampezzo"].includes(p))).toBe(true);
    const summer = planDestinations(req({ interests: ["ski"], window: { from: "2026-07-04", to: "2026-07-12" } }), profile, [], pool);
    const sn = (list: { place: string; score: number }[]) => list.find((c) => c.place === "Sierra Nevada")!.score;
    expect(sn(winter)).toBeGreaterThan(sn(summer));
  });

  it("leaves out places beyond the hour limit, unless the trip is long", () => {
    const short = planDestinations(req(), profile, [], pool);
    expect(short.find((c) => c.place === "Tokyo")).toBeUndefined();
    expect(short.find((c) => c.place === "Lisbon")).toBeDefined();
    const long = planDestinations(req({ nights: { min: 10, max: 14 } }), profile, [], pool);
    expect(long.find((c) => c.place === "Tokyo")).toBeDefined();
  });

  it("lowers a place visited in the last 12 months, unless rated 4 or more, and boosts the wishlist", () => {
    const trip = (rating?: number): PastTrip => ({ id: "t", title: "Lisbon", from: "2026-05-01", to: "2026-05-04", places: ["Lisbon"], tags: [], source: "loco", ...(rating ? { rating } : {}) });
    const score = (h: PastTrip[]) => planDestinations(req(), profile, h, pool).find((c) => c.place === "Lisbon")!;
    expect(score([trip()]).score).toBeLessThan(score([]).score);
    expect(score([trip(5)]).score).toBeGreaterThan(score([trip()]).score);
    expect(score([trip()]).reasons.join(" ")).toContain("you were there recently (May 2026)");
    const madeira = planDestinations(req(), profile, [], pool).find((c) => c.place === "Madeira")!;
    expect(madeira.reasons).toContain("on your wishlist");
    const without = planDestinations(req(), { ...profile, wishlist: [] }, [], pool).find((c) => c.place === "Madeira")!;
    expect(madeira.score).toBeGreaterThan(without.score);
  });

  it("filters to one destination when the request names it", () => {
    const out = planDestinations(req({ destination: "Lisboa" }), profile, [], pool);
    expect(out).toEqual([]);
    const lisbon = planDestinations(req({ destination: "lisbon" }), profile, [], pool);
    expect(top(lisbon)).toEqual(["Lisbon"]);
    expect(top(planDestinations(req({ destination: "LIS" }), profile, [], pool))).toEqual(["Lisbon"]);
  });

  it("uses fares only as given: cheaper ranks better, and cheapest_flight comes from the map", () => {
    const prov = { source: "kiwi-mcp", seen_at: "2026-10-23T08:00:00+02:00" };
    const fares = new Map([
      ["Lisbon", { price: { amount_minor: 6000, currency: "EUR" }, provenance: prov }],
      ["Porto", { price: { amount_minor: 14000, currency: "EUR" }, provenance: prov }],
    ]);
    const base = planDestinations(req(), profile, [], pool);
    const withFares = planDestinations(req(), profile, [], pool, fares);
    const l = withFares.find((c) => c.place === "Lisbon")!;
    const p = withFares.find((c) => c.place === "Porto")!;
    expect(l.cheapest_flight).toEqual({ amount_minor: 6000, currency: "EUR" });
    expect(l.flight_provenance).toEqual(prov);
    expect(l.reasons).toContain("cheapest fare found, €60");
    expect(p.reasons).toContain("fare found at €140");
    expect(l.score - p.score).toBeGreaterThan(base.find((c) => c.place === "Lisbon")!.score - base.find((c) => c.place === "Porto")!.score);
    expect(withFares.find((c) => c.place === "Rome")!.cheapest_flight).toBeUndefined();
    expect(base.every((c) => c.cheapest_flight === undefined)).toBe(true);
  });

  it("returns schema-valid candidates sorted by score, without prices unless a fare was given", () => {
    const out = planDestinations(req(), profile, [], pool);
    for (const c of out) expect(() => DestinationCandidateSchema.parse(c)).not.toThrow();
    const scores = out.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const c of out) for (const r of c.reasons) expect(r).not.toMatch(/[€$£]/);
  });

  it("only prints hours that the pool holds", () => {
    const out = planDestinations(req(), profile, [], pool);
    const allowed = new Set(pool.flatMap((d) => Object.values(d.flight_hours_from)).map(String));
    for (const c of out) for (const r of c.reasons) {
      const m = r.match(/^about ([\d.]+) h from/);
      if (m) expect(allowed.has(m[1]!), r).toBe(true);
    }
  });
});

describe("origins without data", () => {
  const tokyo = pool.find((d) => d.place === "Tokyo")!;
  const lisbon = pool.find((d) => d.place === "Lisbon")!;

  it("borrows hours only for the listed hubs and their near airports", () => {
    expect(hoursFromHome(lisbon, ["VLC"])).toEqual({ hours: lisbon.flight_hours_from.VLC, from: "VLC" });
    expect(hoursFromHome(lisbon, ["ALC"])).toEqual({ hours: lisbon.flight_hours_from.VLC, from: "VLC" });
    expect(hoursFromHome(lisbon, ["MAD", "VLC"])!.hours).toBe(Math.min(lisbon.flight_hours_from.MAD!, lisbon.flight_hours_from.VLC!));
    expect(hoursFromHome(lisbon, ["LHR"])).toBeNull();
    expect(hoursFromHome(lisbon, ["LHR", "JFK"])).toBeNull();
  });

  it("treats reachability as unknown for an unknown origin: no penalty, no reason, nothing excluded", () => {
    const r = req({ origin: ["LHR"] });
    const out = planDestinations(r, profile, [], pool);
    expect(out.find((c) => c.place === "Tokyo")).toBeDefined(); // not dropped for being far from VLC
    expect(tokyo).toBeDefined();
    for (const c of out) expect(c.reasons.some((x) => x.startsWith("about ")), c.place).toBe(false);
    expect(out).toHaveLength(pool.length);
  });
});
