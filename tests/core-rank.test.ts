import { describe, expect, it } from "vitest";
import { rank, WEIGHTS, type RankContext, type RankFeedback } from "../src/core/rank";
import { FeedItemSchema, ProfileSchema, type Observation, type PastTrip } from "../src/core/schema";
import type { Destination } from "../src/core/destinations";

const NOW = new Date("2026-10-23T10:00:00Z");
const FRESH = "2026-10-23T08:00:00+02:00";

const profile = ProfileSchema.parse({
  home_city: "Valencia",
  home_airports: ["VLC", "ALC", "MAD", "BCN"],
  interests: { kitesurf: 2, beach: 1, nightlife: -2 },
  budget: { flight_max: { amount_minor: 25000, currency: "EUR" }, night_max: { amount_minor: 12000, currency: "EUR" } },
  flight: { max_stops: 1, max_hours_one_way: 8, preferred_airlines: ["Vueling"], avoid_airlines: ["Wizz"] },
  free_windows: [{ from: "2026-12-05", to: "2026-12-10" }],
  busy: [{ from: "2026-12-18", to: "2026-12-20", what: "Loco: family trip" }],
  wishlist: ["Madeira"],
});

type Flight = Extract<Observation, { kind: "flight" }>;
function flight(id: string, price: number, over: Partial<Flight> = {}): Flight {
  return {
    kind: "flight", id, title: "VLC to LIS", place: "Lisbon", tags: [],
    provenance: { source: "kiwi-mcp", seen_at: FRESH },
    origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-09",
    price: { amount_minor: price, currency: "EUR" }, stops: 0, duration_minutes: 155, legs: [],
    ...over,
  } as Flight;
}
const withDates = (id: string, price: number, depart: string, ret: string, over: Partial<Flight> = {}) =>
  flight(id, price, { depart_date: depart, return_date: ret, ...over });

function ctx(over: Partial<RankContext> = {}): RankContext {
  return { profile, history: [], feedback: [], now: NOW, ...over };
}
const item = (items: ReturnType<typeof rank>, id: string) => items.find((i) => i.observation.id === id);

// A usual VLC-LIS fare around EUR 120 in December, on different dates so they are not duplicates.
const usual = [
  withDates("u1", 12000, "2026-12-01", "2026-12-04"),
  withDates("u2", 12000, "2026-12-12", "2026-12-15"),
  withDates("u3", 12000, "2026-12-26", "2026-12-29"),
];

describe("weights", () => {
  it("are pinned to the architecture and sum to 1", () => {
    expect(WEIGHTS).toEqual({ deal: 0.35, fit: 0.25, taste: 0.2, urgency: 0.1, novelty: 0.1 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe("deal", () => {
  it("compares a flight to the median of the same route and month, with a real saving in the reason", () => {
    const cheap = flight("cheap", 8200);
    const items = rank([cheap, ...usual], ctx());
    const c = item(items, "cheap")!;
    expect(c.parts.deal).toBe(1);
    expect(c.reasons).toContain("€38 under the usual VLC–LIS fare");
    const expensive = rank([flight("dear", 15000), ...usual], ctx());
    expect(item(expensive, "dear")!.parts.deal).toBe(0);
    expect(item(expensive, "dear")!.reasons.join(" ")).not.toMatch(/under the usual/);
  });

  it("falls back to the whole route when fewer than 3 share the month", () => {
    const others = [
      withDates("a", 10000, "2026-11-10", "2026-11-13"),
      withDates("b", 10000, "2027-01-10", "2027-01-13"),
    ];
    const items = rank([flight("x", 9000), ...others], ctx());
    expect(item(items, "x")!.reasons).toContain("€10 under the usual VLC–LIS fare");
  });

  it("uses the same place when the route has no history, and says so", () => {
    const others = [
      withDates("a", 20000, "2026-12-01", "2026-12-04", { origin: "MAD" }),
      withDates("b", 20000, "2026-12-12", "2026-12-15", { origin: "MAD" }),
    ];
    const items = rank([flight("x", 15000), ...others], ctx());
    expect(item(items, "x")!.reasons).toContain("€50 under the usual fare to Lisbon");
  });

  it("is neutral (0.4) with no baseline and gives no deal reason", () => {
    const items = rank([flight("solo", 5000)], ctx());
    expect(items[0]!.parts.deal).toBe(0.4);
    expect(items[0]!.reasons.join(" ")).not.toMatch(/usual/);
  });

  it("adds a bonus when the price is under the watch's max_price", () => {
    const o = flight("w", 11000, { watch_id: "watch1" });
    const watches = [{ id: "watch1", kind: "route" as const, label: "Lisbon weekend", origin: [], destination: [], window: { from: "2026-12-01", to: "2026-12-31" }, max_price: { amount_minor: 11500, currency: "EUR" }, every_hours: 24, active: true, created_by: "owner" }];
    const base = item(rank([o, ...usual], ctx()), "w")!;
    const withWatch = item(rank([o, ...usual], ctx({ watches })), "w")!;
    expect(withWatch.parts.deal).toBeCloseTo(Math.min(1, base.parts.deal + 0.25), 3);
    expect(withWatch.reasons.some((r) => r.startsWith("under your €115 limit"))).toBe(true);
  });

  it("scores a stay against night_max and against other stays in the place", () => {
    const stay = (id: string, total: number, name: string): Observation => ({
      kind: "stay", id, title: name, place: "Lisbon", tags: [], name,
      provenance: { source: "booking", seen_at: FRESH },
      check_in: "2026-12-06", check_out: "2026-12-09", price_total: { amount_minor: total, currency: "EUR" },
    });
    const items = rank([stay("s1", 21000, "Cheap"), stay("s2", 45000, "Mid"), stay("s3", 45000, "Mid2"), stay("s4", 60000, "Dear")], ctx());
    const s1 = item(items, "s1")!;
    expect(s1.parts.deal).toBeGreaterThan(item(items, "s4")!.parts.deal);
    expect(s1.reasons).toContain("€70 a night, within your €120 budget");
    expect(s1.reasons.some((r) => r.endsWith("a night under the usual Lisbon stay"))).toBe(true);
  });
});

describe("stale", () => {
  it("scores deal 0 and sets stale when expires_at has passed", () => {
    const o = flight("old", 5000, { provenance: { source: "kiwi-mcp", seen_at: FRESH, expires_at: "2026-10-22T00:00:00Z" } });
    const i = item(rank([o, ...usual], ctx()), "old")!;
    expect(i.stale).toBe(true);
    expect(i.parts.deal).toBe(0);
    expect(i.reasons[0]).toBe("offer has expired");
  });

  it("treats a flight seen more than 48 h ago without expiry as stale; other kinds wait 7 days", () => {
    const oldFlight = flight("f", 5000, { provenance: { source: "x", seen_at: "2026-10-20T08:00:00+02:00" } });
    expect(item(rank([oldFlight], ctx()), "f")!.stale).toBe(true);
    const stay = (id: string, seen: string): Observation => ({
      kind: "stay", id, title: id, place: "Lisbon", tags: [], name: id, provenance: { source: "b", seen_at: seen },
      check_in: "2026-12-06", check_out: "2026-12-09", price_total: { amount_minor: 30000, currency: "EUR" },
    });
    const items = rank([stay("fresh", "2026-10-20T08:00:00+02:00"), stay("old", "2026-10-15T08:00:00+02:00")], ctx());
    expect(item(items, "fresh")!.stale).toBe(false);
    expect(item(items, "old")!.stale).toBe(true);
  });

  it("does not use a stale price as a baseline", () => {
    const staleUsual = usual.map((u) => ({ ...u, id: `s-${u.id}`, provenance: { source: "x", seen_at: "2026-10-01T08:00:00+02:00" } }));
    const items = rank([flight("x", 8200), ...staleUsual], ctx());
    expect(item(items, "x")!.parts.deal).toBe(0.4);
  });
});

describe("dedupe", () => {
  it("keeps the cheapest of the same route and dates and names the other sources", () => {
    const a = flight("k", 9900, { provenance: { source: "kiwi-mcp", seen_at: FRESH } });
    const b = flight("t", 8900, { provenance: { source: "travelpayouts", seen_at: FRESH } });
    const c = flight("s", 9500, { provenance: { source: "skyscanner-agent", seen_at: FRESH } });
    const items = rank([a, b, c], ctx());
    expect(items).toHaveLength(1);
    expect(items[0]!.observation.id).toBe("t");
    expect(items[0]!.reasons).toContain("also seen on kiwi-mcp, skyscanner-agent");
  });

  it("does not merge different dates", () => {
    const items = rank([flight("a", 9000), withDates("b", 9000, "2026-12-07", "2026-12-09")], ctx());
    expect(items).toHaveLength(2);
  });
});

describe("feedback", () => {
  it("excludes dismissed and booked observations", () => {
    const fb: RankFeedback[] = [
      { observation_id: "a", action: "dismissed", at: "2026-10-22T10:00:00Z" },
      { observation_id: "b", action: "booked", at: "2026-10-22T10:00:00Z" },
    ];
    const items = rank([flight("a", 9000), withDates("b", 9000, "2026-12-07", "2026-12-09"), withDates("c", 9000, "2026-12-08", "2026-12-09")], ctx({ feedback: fb }));
    expect(items.map((i) => i.observation.id)).toEqual(["c"]);
  });

  it("halves the score of the same place and kind for 30 days after a dismissal, then stops", () => {
    const dismissed = flight("gone", 9000, { depart_date: "2026-12-01", return_date: "2026-12-03" });
    const other = flight("other", 9000, { depart_date: "2026-12-07", return_date: "2026-12-09" });
    const baseline = item(rank([dismissed, other], ctx()), "other")!;
    const recent = item(rank([dismissed, other], ctx({ feedback: [{ observation_id: "gone", action: "dismissed", at: "2026-10-10T10:00:00Z" }] })), "other")!;
    expect(recent.score).toBeCloseTo(baseline.score * 0.5, 2);
    expect(recent.reasons.some((r) => r.startsWith("lowered:"))).toBe(true);
    const old = item(rank([dismissed, other], ctx({ feedback: [{ observation_id: "gone", action: "dismissed", at: "2026-09-10T10:00:00Z" }] })), "other")!;
    expect(old.score).toBeCloseTo(baseline.score, 5);
  });

  it("reports the saved and seen states", () => {
    const fb: RankFeedback[] = [
      { observation_id: "a", action: "saved", at: "2026-10-22T10:00:00Z" },
      { observation_id: "a", action: "seen", at: "2026-10-22T11:00:00Z" },
      { observation_id: "b", action: "seen", at: "2026-10-22T11:00:00Z" },
    ];
    const items = rank([flight("a", 9000), withDates("b", 9000, "2026-12-07", "2026-12-09"), withDates("c", 9000, "2026-12-08", "2026-12-09")], ctx({ feedback: fb }));
    expect(item(items, "a")!.state).toBe("saved");
    expect(item(items, "b")!.state).toBe("seen");
    expect(item(items, "c")!.state).toBe("new");
  });

  it("moves tags by one step on more-like-this and less-like-this for 90 days", () => {
    const base = (id: string, tags: Observation["tags"], place: string): Observation => ({
      kind: "event", id, title: id, place, tags, date: "2027-02-10", provenance: { source: "tm", seen_at: FRESH },
    });
    const liked = base("liked", ["wine"], "Porto");
    const probe = base("probe", ["wine"], "Bordeaux");
    const none = item(rank([liked, probe], ctx()), "probe")!.parts.taste;
    const more = item(rank([liked, probe], ctx({ feedback: [{ observation_id: "liked", action: "more-like-this", at: "2026-10-01T00:00:00Z" }] })), "probe")!.parts.taste;
    const less = item(rank([liked, probe], ctx({ feedback: [{ observation_id: "liked", action: "less-like-this", at: "2026-10-01T00:00:00Z" }] })), "probe")!.parts.taste;
    const expired = item(rank([liked, probe], ctx({ feedback: [{ observation_id: "liked", action: "more-like-this", at: "2026-06-01T00:00:00Z" }] })), "probe")!.parts.taste;
    expect(more).toBeGreaterThan(none);
    expect(less).toBeLessThan(none);
    expect(expired).toBe(none);
  });
});

describe("fit", () => {
  it("rewards a free window and the first home airport", () => {
    const i = item(rank([flight("in", 9000)], ctx()), "in")!;
    expect(i.reasons).toContain("fits your 5–10 Dec free window");
    expect(i.reasons).toContain("leaves from your home airport VLC");
    expect(i.reasons).toContain("direct, 2 h 35 min");
  });

  it("penalises an overlap with busy dates and says which", () => {
    const clash = withDates("clash", 9000, "2026-12-18", "2026-12-21");
    const ok = withDates("ok", 9000, "2026-12-06", "2026-12-09");
    const items = rank([clash, ok], ctx());
    expect(item(items, "clash")!.parts.fit).toBeLessThan(item(items, "ok")!.parts.fit - 0.3);
    expect(item(items, "clash")!.reasons).toContain("clashes with your busy dates 18–20 Dec (Loco: family trip)");
    expect(items[0]!.observation.id).toBe("ok");
  });

  it("prefers an earlier airport in the list, direct over too many stops, and flags avoided airlines", () => {
    const vlc = flight("vlc", 9000);
    const bcn = withDates("bcn", 9000, "2026-12-07", "2026-12-09", { origin: "BCN" });
    const stops = withDates("stops", 9000, "2026-12-08", "2026-12-09", { stops: 3, duration_minutes: 900 });
    const wizz = withDates("wizz", 9000, "2026-12-09", "2026-12-10", { seller: "Wizz Air" });
    const vueling = withDates("vue", 9000, "2026-12-05", "2026-12-06", { seller: "Vueling" });
    const items = rank([vlc, bcn, stops, wizz, vueling], ctx());
    const fit = (id: string) => item(items, id)!.parts.fit;
    expect(fit("vlc")).toBeGreaterThan(fit("bcn"));
    expect(fit("vlc")).toBeGreaterThan(fit("stops"));
    expect(fit("vlc")).toBeGreaterThan(fit("wizz"));
    expect(item(items, "wizz")!.reasons).toContain("Wizz is on your avoid list");
    expect(item(items, "vue")!.reasons).toContain("Vueling is one of your preferred airlines");
    expect(item(items, "stops")!.reasons).toContain("3 stops, over your limit of 1");
  });
});

describe("taste, urgency, novelty", () => {
  const destinations: Destination[] = [
    { place: "Tarifa", country: "Spain", airports: ["XRY"], tags: ["kitesurf", "beach"], best_months: [5, 6], flight_hours_from: {}, cost_level: 2 },
    { place: "Madeira", country: "Portugal", airports: ["FNC"], tags: ["hiking"], best_months: [5], flight_hours_from: {}, cost_level: 3 },
  ];
  const ev = (id: string, place: string, over: Partial<Extract<Observation, { kind: "event" }>> = {}): Observation => ({
    kind: "event", id, title: id, place, tags: [], date: "2027-03-10", provenance: { source: "tm", seen_at: FRESH }, ...over,
  });

  it("takes tags from the destination pool and names the strongest interest", () => {
    const items = rank([ev("t", "Tarifa"), ev("m", "Madeira")], ctx({ destinations }));
    expect(item(items, "t")!.reasons).toContain("you love kitesurf");
    expect(item(items, "t")!.parts.taste).toBeGreaterThan(item(items, "m")!.parts.taste);
    expect(item(items, "m")!.reasons).toContain("on your wishlist");
  });

  it("lowers taste for a place visited in the last 12 months, unless it was rated 4 or more", () => {
    const trip = (rating?: number): PastTrip => ({ id: "t1", title: "x", from: "2026-03-01", to: "2026-03-05", places: ["Tarifa"], tags: [], source: "loco", ...(rating ? { rating } : {}) });
    const none = item(rank([ev("t", "Tarifa")], ctx({ destinations })), "t")!;
    const visited = item(rank([ev("t", "Tarifa")], ctx({ destinations, history: [trip()] })), "t")!;
    const loved = item(rank([ev("t", "Tarifa")], ctx({ destinations, history: [trip(5)] })), "t")!;
    expect(visited.parts.taste).toBeCloseTo(none.parts.taste - 0.25, 3);
    expect(visited.reasons).toContain("you were there recently (Mar 2026)");
    expect(loved.parts.taste).toBe(none.parts.taste);
    expect(loved.reasons).toContain("you rated your last visit 5/5");
    const longAgo = item(rank([ev("t", "Tarifa")], ctx({ destinations, history: [{ ...trip(), from: "2025-03-01", to: "2025-03-05" }] })), "t")!;
    expect(longAgo.parts.taste).toBe(none.parts.taste);
  });

  it("scores urgency for departures within 30 days and prices expiring within 72 h", () => {
    const soon = flight("soon", 9000, { depart_date: "2026-11-02", return_date: "2026-11-05" });
    const far = flight("far", 9000, { depart_date: "2027-02-02", return_date: "2027-02-05" });
    const expiring = flight("exp", 9000, { depart_date: "2027-03-02", return_date: "2027-03-05", provenance: { source: "x", seen_at: FRESH, expires_at: "2026-10-24T22:00:00Z" } });
    const items = rank([soon, far, expiring], ctx());
    expect(item(items, "soon")!.parts.urgency).toBeGreaterThan(0.7);
    expect(item(items, "soon")!.reasons).toContain("departs in 10 days");
    expect(item(items, "far")!.parts.urgency).toBe(0);
    expect(item(items, "exp")!.parts.urgency).toBeGreaterThan(0.5);
    expect(item(items, "exp")!.reasons).toContain("price expires in 36 h");
  });

  it("gives novelty to places never visited or shown, less once seen, little once visited", () => {
    const history: PastTrip[] = [{ id: "h", title: "x", from: "2024-01-01", to: "2024-01-05", places: ["Tarifa"], tags: [], source: "loco" }];
    const items = rank([ev("t", "Tarifa"), ev("m", "Madeira"), ev("p", "Porto")], ctx({ history, feedback: [{ observation_id: "m", action: "seen", at: "2026-10-20T00:00:00Z" }] }));
    expect(item(items, "t")!.parts.novelty).toBe(0.1);
    expect(item(items, "m")!.parts.novelty).toBe(0.4);
    expect(item(items, "p")!.parts.novelty).toBe(1);
    expect(item(items, "p")!.reasons).toContain("a place you have not been to");
  });
});

describe("output", () => {
  it("returns schema-valid feed items sorted best first", () => {
    const items = rank([flight("cheap", 8200), flight("dear", 15000, { depart_date: "2026-12-07", return_date: "2026-12-09" }), ...usual], ctx());
    for (const i of items) expect(() => FeedItemSchema.parse(i)).not.toThrow();
    const scores = items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(items[0]!.observation.id).toBe("cheap");
  });

  it("does not mutate its inputs", () => {
    const obs = [flight("a", 9000), ...usual];
    const copy = JSON.stringify(obs);
    rank(obs, ctx());
    expect(JSON.stringify(obs)).toBe(copy);
  });

  it("never prints a number that is absent from the inputs", () => {
    const cheap = flight("cheap", 8200, { legs: [] });
    const clash = withDates("clash", 9400, "2026-12-18", "2026-12-21", { stops: 3, duration_minutes: 905 });
    const soon = flight("soon", 7700, { depart_date: "2026-11-02", return_date: "2026-11-05", provenance: { source: "x", seen_at: FRESH, expires_at: "2026-10-24T22:00:00Z" } });
    const stay: Observation = {
      kind: "stay", id: "stay", title: "Loft", place: "Lisbon", tags: [], name: "Loft", rating: 8.7,
      provenance: { source: "booking", seen_at: FRESH }, check_in: "2026-12-06", check_out: "2026-12-09", price_total: { amount_minor: 21000, currency: "EUR" },
    };
    const inputs = [cheap, clash, soon, stay, ...usual];
    const items = rank(inputs, ctx({ history: [{ id: "h", title: "x", from: "2026-03-01", to: "2026-03-05", places: ["Lisbon"], rating: 5, tags: [], source: "loco" }] }));

    // Numbers that appear anywhere in the inputs (profile included), money in major units, and the
    // differences and per-night prices computed from them.
    const text = JSON.stringify([inputs, profile]);
    const allowed = new Set<string>((text.match(/\d+/g) ?? []).map((n) => String(Number(n))));
    const minors = [...text.matchAll(/"amount_minor":(\d+)/g)].map((m) => Number(m[1]));
    for (const a of minors) {
      allowed.add(String(a / 100));
      for (const b of minors) { allowed.add(String(Math.abs(a - b) / 100)); }
    }
    allowed.add("70"); // 21000 / 3 nights / 100
    allowed.add("10"); // soon departs in 10 days (2026-10-23 -> 2026-11-02)
    allowed.add("36"); // expires 2026-10-24T22:00Z, from 2026-10-23T10:00Z
    allowed.add("2"); allowed.add("35"); // 155 minutes = 2 h 35 min is in the inputs; hours part of 905 = 15 h 5 min
    allowed.add("15");

    const reasons = items.flatMap((i) => i.reasons);
    expect(reasons.length).toBeGreaterThan(5);
    for (const r of reasons) {
      for (const n of r.match(/\d+(?:\.\d+)?/g) ?? []) {
        expect(allowed.has(String(Number(n))), `"${r}" contains ${n}`).toBe(true);
      }
    }
  });
});
