import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSchema } from "../src/core/schema";
import { toLocoProposal } from "../src/core/loco";
import { PlanError, archivePlan, choosePlace, cheapestFares, getPlan, listPlans, MAX_CALLS_PER_STEP, planNotices, startPlan, type PlanDeps } from "../src/server/plan";
import { loadDestinations } from "../src/server/destinations";
import { createStore, openDb, type Db, type Store } from "../src/server/store";
import { FARE_MINOR, NOW, POOL, fakeActivities, fakeEvents, fakeFlights, fakeSource, fakeStays, memoryLedger } from "./plan-support";

let db: Db;
let store: Store;

const PROFILE = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], currency: "EUR", travellers: { adults: 2 }, interests: { food: 2 } });

beforeEach(() => {
  db = openDb(":memory:");
  store = createStore(db);
  store.putProfile(PROFILE, NOW);
});
afterEach(() => db.close());

function deps(over: PlanDeps = {}): PlanDeps {
  return {
    store,
    now: NOW,
    env: {},
    destinations: POOL,
    ledger: memoryLedger(),
    ai: false,
    sources: [fakeFlights(), fakeStays(), fakeActivities(), fakeEvents()],
    ...over,
  };
}

const TEXT = "4 days of kitesurf in December, under €600, with my wife";

describe("startPlan: from a sentence to ranked candidates with live fares", () => {
  it("reads the sentence, ranks the pool and takes fares only from observations", async () => {
    const flights = fakeFlights();
    const plan = await startPlan("owner", { text: TEXT }, deps({ sources: [flights, fakeStays()] }));

    expect(plan.status).toBe("choosing");
    expect(plan.request).toMatchObject({
      text: TEXT,
      window: { from: "2026-12-01", to: "2026-12-31" },
      nights: { min: 3, max: 4 },
      interests: ["kitesurf"],
      budget_total: { amount_minor: 60000, currency: "EUR" },
      travellers: { adults: 2, children: 0 },
      origin: ["VLC"],
    });
    expect(plan.candidates.length).toBeGreaterThan(1);
    expect(plan.candidates.length).toBeLessThanOrEqual(5);
    expect(plan.candidates[0]!.place).toBe("Tarifa"); // the kitesurf place leads

    // One flights query per candidate with airports, searching departure days that still fit the window.
    const q = flights.queries[0]!;
    expect(q).toMatchObject({ kind: "flights", origin: ["VLC"], adults: 2, currency: "EUR" });
    if (q.kind === "flights") expect(q.window).toEqual({ from: "2026-12-01", to: "2026-12-28" });

    // Every fare on a candidate is an observation the fake source returned: same amount, same provenance.
    const tarifa = plan.candidates.find((c) => c.place === "Tarifa")!;
    expect(tarifa.cheapest_flight).toEqual({ amount_minor: FARE_MINOR.XRY, currency: "EUR" }); // XRY beats AGP
    expect(tarifa.flight_provenance).toMatchObject({ source: "fake-fares", seen_at: NOW.toISOString() });
    const stored = store.listObservations({ kinds: ["flight"], now: NOW });
    expect(stored.length).toBeGreaterThanOrEqual(plan.candidates.length);
    for (const c of plan.candidates) {
      expect(stored.some((o) => o.kind === "flight" && o.price.amount_minor === c.cheapest_flight?.amount_minor && o.provenance.source === c.flight_provenance?.source)).toBe(true);
    }
  });

  it("leaves cheapest_flight out for a place no source priced", async () => {
    const onlyLisbon = fakeFlights("fares-lis", {});
    const filter = fakeSource({ name: "lis-only", kinds: ["flight"], search: async (q, ctx) => (await onlyLisbon.search(q, ctx)).filter((o) => o.kind === "flight" && o.destination === "LIS") });
    const plan = await startPlan("owner", { text: "5 nights of food and culture in December" }, deps({ sources: [filter] }));
    const withFare = plan.candidates.filter((c) => c.cheapest_flight);
    expect(withFare.map((c) => c.place)).toEqual(["Lisbon"]);
    for (const c of plan.candidates.filter((x) => x.place !== "Lisbon")) {
      expect(c.cheapest_flight).toBeUndefined();
      expect(c.flight_provenance).toBeUndefined();
    }
  });

  it("ranks candidates by fares from the requested origins only", async () => {
    const base = fakeFlights("fares-two", {});
    const twoOrigins = fakeSource({
      name: "two-origins",
      kinds: ["flight"],
      search: async (q, ctx) => {
        const vlc = await base.search(q, ctx);
        // A much cheaper fare from Madrid, an airport the profile and the request do not use.
        const mad = vlc.map((o) => (o.kind === "flight" ? { ...o, id: `${o.id}_mad`, origin: "MAD", price: { amount_minor: 1000, currency: "EUR" } } : o));
        return [...vlc, ...mad];
      },
    });
    const plan = await startPlan("owner", { text: "5 nights of food and culture in December" }, deps({ sources: [twoOrigins] }));
    const lisbon = plan.candidates.find((c) => c.place === "Lisbon")!;
    expect(lisbon.cheapest_flight).toEqual({ amount_minor: FARE_MINOR.LIS, currency: "EUR" });
  });

  it("works with every source off: candidates have no fares and the reasons say why", async () => {
    const off = fakeFlights("fares-off", { enabled: false });
    const plan = await startPlan("owner", { text: TEXT }, deps({ sources: [off] }));
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((c) => c.cheapest_flight === undefined)).toBe(true);
    const notes = planNotices("owner", plan.id, { store });
    expect(notes).toEqual([expect.objectContaining({ source: "fares-off", ok: false, step: "fares", error: "FARES-OFF_KEY is not set" })]);
  });

  it("never fails because a source fails; the failure is recorded and shown", async () => {
    const broken = fakeSource({ name: "broken", kinds: ["flight"], search: () => { throw new Error("HTTP 500 from broken"); } });
    const plan = await startPlan("owner", { text: TEXT }, deps({ sources: [broken, fakeFlights()] }));
    expect(plan.candidates.some((c) => c.cheapest_flight)).toBe(true);
    const notes = planNotices("owner", plan.id, { store });
    expect(notes.find((n) => n.source === "broken")).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 500") });
    expect(notes.find((n) => n.source === "fake-fares")).toMatchObject({ ok: true });
  });

  it("makes at most 12 source calls in this step", async () => {
    const pricey = fakeFlights("pricey", { callsFor: 5 });
    await startPlan("owner", { text: "a week of city and culture in December" }, deps({ sources: [pricey] }));
    // Five candidates would cost 25 calls; only the first two (10 calls) fit under 12.
    expect(pricey.queries.length).toBe(2);
    expect(pricey.queries.length * 5).toBeLessThanOrEqual(MAX_CALLS_PER_STEP);
  });

  it("fills the profile's travellers and home airports when the sentence has none", async () => {
    const plan = await startPlan("owner", { text: "a week in December, city" }, deps({ sources: [fakeFlights()] }));
    expect(plan.request.travellers).toEqual({ adults: 2, children: 0 });
    expect(plan.request.origin).toEqual(["VLC"]);
  });

  it("lets form fields beat the sentence", async () => {
    const plan = await startPlan("owner", { text: TEXT, request: { nights: { min: 6, max: 7 }, travellers: { adults: 1, children: 0 } } }, deps({ sources: [fakeFlights()] }));
    expect(plan.request.nights).toEqual({ min: 6, max: 7 });
    expect(plan.request.travellers).toEqual({ adults: 1, children: 0 });
    expect(plan.request.interests).toEqual(["kitesurf"]);
  });

  it("uses defaults when the sentence says almost nothing, and the window never starts in the past", async () => {
    const plan = await startPlan("owner", { text: "somewhere nice" }, deps({ sources: [fakeFlights()] }));
    expect(plan.request.window.from >= "2026-10-23").toBe(true);
    expect(plan.request.nights).toEqual({ min: 3, max: 5 });
  });

  it("asks for a profile and for some input", async () => {
    const empty = createStore(openDb(":memory:"), "someone");
    await expect(startPlan("someone", { text: TEXT }, deps({ store: empty }))).rejects.toMatchObject({ code: "no_profile" });
    await expect(startPlan("owner", {}, deps())).rejects.toBeInstanceOf(PlanError);
    await expect(startPlan("owner", { text: "   " }, deps())).rejects.toBeInstanceOf(PlanError);
  });
});

describe("startPlan: the AI step", () => {
  const ON = { ACCOUNTS_SERVICE_RUMBO: "svc" };
  const hub = (args: unknown) =>
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      const name = JSON.parse(String(init?.body)).tool_choice.function.name;
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;

  it("runs only when the rules are unsure, and fills only the gaps", async () => {
    const f = hub({ destination: "Rome", interests: ["wine"], window_from: "2026-11-01", window_to: "2026-11-30", nights_min: 9, nights_max: 9 });
    const plan = await startPlan("owner", { text: "padel and sun in January" }, deps({ sources: [fakeFlights()], ai: { env: ON, fetch: f } }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(plan.request.interests).toEqual(["padel", "beach"]); // the rules' own findings stand
    expect(plan.request.window).toEqual({ from: "2027-01-01", to: "2027-01-31" });
    expect(plan.request.destination).toBe("Rome"); // the gap the AI filled
    expect(plan.request.nights).toEqual({ min: 9, max: 9 });
  });

  it("is not called when the rules are sure, or when the AI is off", async () => {
    const f = hub({ destination: "Rome" });
    await startPlan("owner", { text: "4 days of kitesurf in December, under €600, with my wife" }, deps({ sources: [fakeFlights()], ai: { env: ON, fetch: f } }));
    await startPlan("owner", { text: "somewhere nice" }, deps({ sources: [fakeFlights()], ai: { env: { ...ON, RUMBO_AI: "off" }, fetch: f } }));
    await startPlan("owner", { text: "somewhere nice" }, deps({ sources: [fakeFlights()], ai: { env: {}, fetch: f } }));
    expect(f).not.toHaveBeenCalled();
  });

  it("falls back to the rules when the hub fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = (async () => { throw new TypeError("down"); }) as unknown as typeof fetch;
    const plan = await startPlan("owner", { text: "somewhere nice" }, deps({ sources: [fakeFlights()], ai: { env: ON, fetch: boom } }));
    expect(plan.status).toBe("choosing");
    warn.mockRestore();
  });
});

describe("choosePlace: from a place to a plan", () => {
  it("fills every section from observations, ranked, with links for each", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps());
    const cheapestDates = (() => {
      const f = store.listObservations({ kinds: ["flight"], now: NOW }).filter((o) => o.kind === "flight" && o.destination === "XRY");
      const o = f[0]!;
      return o.kind === "flight" ? { from: o.depart_date, to: o.return_date! } : undefined;
    })();

    const plan = await choosePlace("owner", started.id, "Tarifa", undefined, deps());
    expect(plan.status).toBe("ready");
    expect(plan.chosen).toBe("Tarifa");
    expect(plan.dates).toEqual(cheapestDates); // the cheapest fare's dates

    // Section ids are real observations, with the right kind and dates.
    const get = (id: string) => store.getObservation(id)!;
    expect(plan.sections.flights.length).toBeGreaterThan(0);
    for (const id of plan.sections.flights) expect(get(id)).toMatchObject({ kind: "flight", depart_date: plan.dates!.from });
    expect(plan.sections.stay).toHaveLength(3);
    for (const id of plan.sections.stay) expect(get(id)).toMatchObject({ kind: "stay", check_in: plan.dates!.from, check_out: plan.dates!.to });
    expect(plan.sections.activities).toHaveLength(2);
    expect(plan.sections.events.map((id) => get(id).title)).toEqual(["Concert in Tarifa"]); // the June 2027 event is outside the trip
    expect(plan.sections.car).toEqual([]);

    // Ranked: the order is the ranker's, and it does not list duplicates.
    expect(new Set(Object.values(plan.sections).flat()).size).toBe(Object.values(plan.sections).flat().length);

    // Links for every section, including Car.
    for (const section of ["flights", "stay", "car", "activities"]) {
      expect(plan.links.filter((l) => l.section === section).length).toBeGreaterThan(0);
    }
    expect(plan.links.some((l) => l.label.includes("Tarifa") || l.url.includes("Tarifa"))).toBe(true);
    expect(getPlan("owner", plan.id, { store })).toEqual(plan);

    // It round-trips into the Loco proposal.
    const obs = Object.values(plan.sections).flat().map(get);
    const proposal = toLocoProposal(plan, obs);
    expect(proposal.proposal.options.length).toBe(obs.length);
    expect(proposal.proposal.options.every((o) => o.seen.by === "rumbo")).toBe(true);
  });

  it("uses the dates the owner gives", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps());
    const plan = await choosePlace("owner", started.id, "Rome", { from: "2026-12-10", to: "2026-12-13" }, deps());
    expect(plan.dates).toEqual({ from: "2026-12-10", to: "2026-12-13" });
    for (const id of plan.sections.flights) expect(store.getObservation(id)).toMatchObject({ depart_date: "2026-12-10", return_date: "2026-12-13" });
    for (const id of plan.sections.stay) expect(store.getObservation(id)).toMatchObject({ check_in: "2026-12-10", check_out: "2026-12-13" });
  });

  it("falls back to the window start plus the shortest stay when no fare was found", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps({ sources: [fakeFlights("off", { enabled: false })] }));
    const plan = await choosePlace("owner", started.id, "Lisbon", undefined, deps({ sources: [] }));
    expect(plan.dates).toEqual({ from: "2026-12-01", to: "2026-12-04" });
  });

  it("ignores cached fares from airports the trip does not use", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps({ sources: [] }));
    store.upsertObservations([
      flightObs("mad", { origin: "MAD", depart_date: "2026-12-10", return_date: "2026-12-13", price: { amount_minor: 100, currency: "EUR" } }),
      flightObs("vlc", { origin: "VLC", depart_date: "2026-12-20", return_date: "2026-12-23", price: { amount_minor: 9000, currency: "EUR" } }),
    ]);
    const plan = await choosePlace("owner", started.id, "Lisbon", undefined, deps({ sources: [] }));
    expect(plan.dates).toEqual({ from: "2026-12-20", to: "2026-12-23" }); // the VLC fare, not the cheaper MAD one
  });

  it("keeps the fallback dates inside the window, and says when the window is too short", async () => {
    const started = await startPlan("owner", { text: "5 nights in December", request: { window: { from: "2026-12-01", to: "2026-12-03" }, nights: { min: 5, max: 5 } } }, deps({ sources: [] }));
    const plan = await choosePlace("owner", started.id, "Lisbon", undefined, deps({ sources: [] }));
    expect(plan.dates).toEqual({ from: "2026-12-01", to: "2026-12-03" });
    // A named place is planned straight away, so the one-day window fails in startPlan.
    await expect(startPlan("owner", { text: "Lisbon", request: { window: { from: "2026-12-01", to: "2026-12-01" } } }, deps({ sources: [] }))).rejects.toThrow(/too short/);
  });

  it("rejects dates it picked itself when they are in the past, like dates the owner typed", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps({ sources: [] }));
    const old = deps({ sources: [], now: new Date("2027-03-01T08:00:00Z") }); // the saved plan's window is now over
    await expect(choosePlace("owner", started.id, "Lisbon", undefined, old)).rejects.toThrow(/past|too short/);
    expect(store.getPlan(started.id)!.status).toBe("choosing");
  });

  it("does not bring back a plan archived in another tab while its search ran", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps({ sources: [] }));
    const archiver = fakeSource({
      name: "archiver",
      kinds: ["stay"],
      search: () => {
        archivePlan("owner", started.id, { store, now: NOW });
        return [];
      },
    });
    await expect(choosePlace("owner", started.id, "Lisbon", undefined, deps({ sources: [archiver] }))).rejects.toThrow(/archived/);
    expect(store.getPlan(started.id)!.status).toBe("archived");
  });

  it("shows a failing or missing source and still produces the plan, with links", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps());
    const broken = fakeSource({ name: "stays-broken", kinds: ["stay"], search: () => { throw new Error("HTTP 503"); } });
    const off = fakeActivities("acts-off", { enabled: false });
    const plan = await choosePlace("owner", started.id, "Tarifa", undefined, deps({ sources: [fakeFlights(), broken, off, fakeEvents()] }));
    expect(plan.status).toBe("ready");
    expect(plan.sections.stay).toEqual([]);
    expect(plan.sections.activities).toEqual([]);
    expect(plan.links.some((l) => l.section === "stay")).toBe(true);
    const notes = planNotices("owner", plan.id, { store }).filter((n) => n.step === "choose");
    expect(notes.find((n) => n.source === "stays-broken")).toMatchObject({ ok: false, error: expect.stringContaining("503") });
    expect(notes.find((n) => n.source === "acts-off")).toMatchObject({ ok: false, error: "ACTS-OFF_KEY is not set" });
  });

  it("keeps to 12 source calls and says which source was skipped", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps({ sources: [] }));
    const heavy = [fakeFlights("f", { callsFor: 6 }), fakeStays("s", { callsFor: 5 }), fakeActivities("a", { callsFor: 4 }), fakeEvents("e", { callsFor: 1 })];
    const plan = await choosePlace("owner", started.id, "Tarifa", undefined, deps({ sources: heavy }));
    const ran = heavy.filter((s) => (s as unknown as { queries: unknown[] }).queries.length > 0).map((s) => s.name);
    expect(ran).toEqual(["f", "s", "e"]); // 6 + 5 + 1 = 12; the 4-call activities source no longer fits
    const skipped = planNotices("owner", plan.id, { store }).find((n) => n.source === "a")!;
    expect(skipped).toMatchObject({ ok: false, error: expect.stringContaining("limited to 12") });
  });

  it("includes events a collector stored earlier for the place and dates", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps());
    store.upsertObservations([
      { kind: "event", id: "ev_stored", title: "Kite festival", place: "Tarifa", tags: ["festivals"], provenance: { source: "sawk", seen_at: NOW.toISOString() }, date: "2026-12-02" },
    ]);
    const plan = await choosePlace("owner", started.id, "Tarifa", { from: "2026-12-01", to: "2026-12-05" }, deps({ sources: [] }));
    expect(plan.sections.events).toContain("ev_stored");
  });

  it("plans a place that is not among the candidates, and rejects bad input", async () => {
    const started = await startPlan("owner", { text: TEXT }, deps());
    const plan = await choosePlace("owner", started.id, "Valencia", undefined, deps({ sources: [] }));
    expect(plan.chosen).toBe("Valencia");
    expect(plan.candidates.some((c) => c.place === "Valencia")).toBe(true);
    await expect(choosePlace("owner", "pl_missing", "Rome", undefined, deps())).rejects.toMatchObject({ code: "not_found" });
    await expect(choosePlace("owner", started.id, "  ", undefined, deps())).rejects.toBeInstanceOf(PlanError);
    await expect(choosePlace("owner", started.id, "Rome", { from: "2026-12-10", to: "2026-12-09" }, deps())).rejects.toThrow(/cannot end/);
    await expect(choosePlace("owner", started.id, "Rome", { from: "2026-01-10", to: "2026-01-12" }, deps())).rejects.toThrow(/past/);
    await expect(choosePlace("owner", started.id, "Rome", { from: "2026-12-10", to: "2027-03-12" }, deps())).rejects.toThrow(/60 nights/);
  });
});

describe("a place that is named", () => {
  it("skips the choosing step and plans it straight away", async () => {
    const plan = await startPlan("owner", { text: "5-9 December in Rome" }, deps());
    expect(plan.status).toBe("ready");
    expect(plan.chosen).toBe("Rome");
    expect(plan.dates).toEqual({ from: "2026-12-05", to: "2026-12-09" });
    expect(plan.sections.flights.length).toBeGreaterThan(0);
    expect(plan.sections.stay.length).toBeGreaterThan(0);
  });

  it("plans a place outside the pool from the name alone, with no airport and a notice", async () => {
    const plan = await startPlan("owner", { text: "3 nights in December", request: { destination: "Gdansk" } }, deps());
    expect(plan.status).toBe("ready");
    expect(plan.chosen).toBe("Gdansk");
    expect(plan.sections.flights).toEqual([]);
    expect(planNotices("owner", plan.id, { store }).some((n) => /no airport known for Gdansk/.test(n.error ?? ""))).toBe(true);
    expect(plan.links.some((l) => l.section === "stay")).toBe(true);
  });

  it("shows candidates when a country names several places", async () => {
    const plan = await startPlan("owner", { text: "a week in Portugal in December" }, deps());
    expect(plan.status).toBe("choosing");
    expect(plan.candidates.map((c) => c.place).sort()).toEqual(["Lisbon", "Madeira"]);
  });
});

describe("plans", () => {
  it("lists and archives plans", async () => {
    const a = await startPlan("owner", { text: TEXT }, deps());
    const b = await startPlan("owner", { text: "5-9 December in Rome" }, deps());
    expect(listPlans("owner", { store }).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(archivePlan("owner", a.id, { store, now: NOW }).status).toBe("archived");
    await expect(choosePlace("owner", a.id, "Rome", undefined, deps())).rejects.toThrow(/archived/);
    expect(() => archivePlan("owner", "pl_missing", { store })).toThrow(PlanError);
  });

  it("keeps plan notices out of the collector's last run", async () => {
    await startPlan("owner", { text: TEXT }, deps());
    expect(store.usage(NOW).last_collect_at).toBe("never");
  });
});

function flightObs(id: string, over: Record<string, unknown>) {
  return { kind: "flight", id, title: "x", place: "Lisbon", tags: [], provenance: { source: "s", seen_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 6 * 3_600_000).toISOString() }, origin: "VLC", destination: "LIS", depart_date: "2026-12-01", return_date: "2026-12-04", price: { amount_minor: 9000, currency: "EUR" }, stops: 0, legs: [], ...over } as never;
}

describe("cheapestFares", () => {
  const f = (o: Record<string, unknown>) => ({ kind: "flight", id: String(o.id), title: "x", place: "Lisbon", tags: [], provenance: { source: "s", seen_at: NOW.toISOString() }, origin: "VLC", destination: "LIS", depart_date: "2026-12-01", return_date: "2026-12-04", price: { amount_minor: 9000, currency: "EUR" }, stops: 0, legs: [], ...o }) as never;
  const req = { window: { from: "2026-12-01", to: "2026-12-10" }, nights: { min: 3, max: 4 }, interests: [], needs: ["flights"] } as never;

  it("takes the cheapest inside the window, preferring the profile currency", () => {
    const fares = cheapestFares([{ place: "Lisbon", airports: ["LIS"] }], [
      f({ id: "a", price: { amount_minor: 9000, currency: "EUR" } }),
      f({ id: "b", price: { amount_minor: 7000, currency: "EUR" } }),
      f({ id: "c", price: { amount_minor: 100, currency: "USD" } }),
      f({ id: "d", price: { amount_minor: 500, currency: "EUR" }, return_date: "2026-12-20" }), // ends after the window
      f({ id: "e", price: { amount_minor: 400, currency: "EUR" }, depart_date: "2026-11-20" }), // starts before it
    ], req, "EUR");
    expect(fares.get("Lisbon")?.price).toEqual({ amount_minor: 7000, currency: "EUR" });
  });

  it("counts only fares from the requested origins", () => {
    const fares = cheapestFares([{ place: "Lisbon", airports: ["LIS"] }], [
      f({ id: "a", price: { amount_minor: 9000, currency: "EUR" } }), // VLC
      f({ id: "b", price: { amount_minor: 3000, currency: "EUR" }, origin: "MAD" }),
    ], req, "EUR", ["VLC"]);
    expect(fares.get("Lisbon")?.price).toEqual({ amount_minor: 9000, currency: "EUR" });
    expect(cheapestFares([{ place: "Lisbon", airports: ["LIS"] }], [f({ id: "b", origin: "MAD" })], req, "EUR", ["VLC"]).size).toBe(0);
  });

  it("returns nothing for a place with no matching fare", () => {
    expect(cheapestFares([{ place: "Rome", airports: ["FCO"] }], [f({ id: "a" })], req, "EUR").size).toBe(0);
  });
});

describe("loadDestinations", () => {
  it("reads the real pool from data/destinations", () => {
    const pool = loadDestinations();
    expect(pool.length).toBeGreaterThan(50);
    expect(pool.some((d) => d.place === "Lisbon")).toBe(true);
  });
});
