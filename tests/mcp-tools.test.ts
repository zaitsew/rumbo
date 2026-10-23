import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationSchema } from "../src/core/schema";
import { buildBrief, candidateDates, isDue, observationExamples } from "../src/server/brief";
import { recentAgentActivity } from "../src/server/agents";
import { listedTools, runTool } from "../src/server/mcp/server";
import { TOOLS, toolByName } from "../src/server/mcp/tools";
import { ingestObservations, observationId } from "../src/server/observe";
import { flightId, legKey } from "../src/server/sources/id";
import { createStore, openDb, type Db, type Store } from "../src/server/store";
import { PROFILE, flight, tempDir, watch } from "./helpers";

// The plan tools call the real source list; swap it for fakes so no test reaches a network.
vi.mock("../src/server/sources", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/sources")>();
  const support = await import("./plan-support");
  return { ...real, ALL_SOURCES: [support.fakeFlights(), support.fakeStays(), support.fakeActivities(), support.fakeEvents()] };
});

const NOW = new Date("2026-10-23T12:00:00Z");
let tmp: ReturnType<typeof tempDir>;
let db: Db;
let s: Store;

beforeEach(() => {
  tmp = tempDir();
  db = openDb(tmp.path);
  s = createStore(db);
});
afterEach(() => {
  db.close();
  tmp.cleanup();
});

async function call(name: string, args: unknown, agent: string | null = null) {
  const res = await runTool(toolByName(name)!, args, { store: s, agent, now: NOW });
  const body = JSON.parse(res.content[0]!.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { isError: res.isError === true, body };
}

const fresh = (id: string, over: Record<string, unknown> = {}) =>
  flight(id, { provenance: { source: "kiwi-mcp", url: "https://example.com/o", seen_at: "2026-10-23T09:00:00Z", expires_at: "2026-10-26T09:00:00Z" }, ...over });

describe("the registry", () => {
  it("lists the thirteen tools with unique names and object input schemas", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.sort()).toEqual(
      ["rumbo_agent_brief", "rumbo_feed", "rumbo_feedback", "rumbo_import_history", "rumbo_observe", "rumbo_plan_choose", "rumbo_plan_get", "rumbo_plan_start", "rumbo_profile_get", "rumbo_profile_update", "rumbo_to_loco", "rumbo_watch_add", "rumbo_watch_list"],
    );
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(40);
  });

  it("answers unknown tools and bad input in the { error, detail } shape", async () => {
    const bad = await call("rumbo_feed", { limit: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBe("invalid_input");
    expect(Array.isArray(bad.body.detail)).toBe(true);
    const notObject = await runTool(toolByName("rumbo_feed")!, [1], { store: s });
    expect(JSON.parse(notObject.content[0]!.text).error).toBe("invalid_input");
  });
});

describe("rumbo_feed and getFeed", () => {
  it("says there is no profile instead of ranking for nobody", async () => {
    const r = await call("rumbo_feed", {});
    expect(r.isError).toBe(false);
    expect(r.body.items).toEqual([]);
    expect(r.body.note).toMatch(/No profile/);
  });

  it("orders by score, drops dismissed and stale items, filters kinds, honours limit", async () => {
    s.putProfile(PROFILE);
    const days = ["2026-12-06", "2026-12-13", "2026-12-20", "2026-12-27"];
    const cents = [5000, 9000, 9500, 9800];
    s.upsertObservations(days.map((d, i) => fresh(`f${i}`, { depart_date: d, return_date: d.replace(/\d\d$/, (x) => String(Number(x) + 3).padStart(2, "0")), price: { amount_minor: cents[i], currency: "EUR" }, seller: `S${i}` })));
    s.upsertObservations([fresh("old", { depart_date: "2026-12-02", return_date: "2026-12-05", seller: "Old", provenance: { source: "kiwi-mcp", url: "https://example.com/o", seen_at: "2026-10-01T09:00:00Z", expires_at: "2026-10-03T09:00:00Z" } })]);
    const r = await call("rumbo_feed", { limit: 10 });
    const ids = r.body.items.map((i: any) => i.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ids).not.toContain("old");
    const scores = r.body.items.map((i: any) => i.score); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    expect(ids[0]).toBe("f0"); // the fare far below the usual one ranks first
    expect(r.body.items[0].reasons.length).toBeGreaterThan(0);
    expect(Object.keys(r.body.items[0].parts).sort()).toEqual(["deal", "fit", "novelty", "taste", "urgency"]);
    expect(r.body.items[0].price.text).toBe("€50");

    expect((await call("rumbo_feed", { limit: 2 })).body.items).toHaveLength(2);
    expect((await call("rumbo_feed", { kinds: ["stay"] })).body.items).toHaveLength(0);

    const fb = await call("rumbo_feedback", { observation_id: "f0", action: "dismissed" });
    expect(fb.isError).toBe(false);
    expect((await call("rumbo_feed", {})).body.items.map((i: any) => i.id)).not.toContain("f0"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call("rumbo_feedback", { observation_id: "nope", action: "saved" })).body.error).toBe("unknown_observation");
  });
});

describe("rumbo_profile_update", () => {
  it("merges, never deletes, keeps untouched fields and appends the note with provenance", async () => {
    s.putProfile({ ...PROFILE, currency: "USD", home_airports: ["VLC"], interests: { food: 2, beach: 1 }, wishlist: ["Lisbon"], free_windows: [{ from: "2026-12-05", to: "2026-12-09" }] });
    const before = s.getProfile()!;
    const r = await call(
      "rumbo_profile_update",
      { set: { home_airports: ["ALC", "VLC"], interests: { kitesurf: 2, food: -1 }, wishlist: ["Tarifa"], budget: { night_max: { amount_minor: 15000, currency: "EUR" } } }, note: "prefers aisle seats", agent: "codex-automation" },
      "ignored-header-agent",
    );
    expect(r.isError).toBe(false);
    const p = s.getProfile()!;
    expect(p.currency).toBe("USD"); // a default must never overwrite what the owner set
    expect(p.home_airports).toEqual(["VLC", "ALC"]);
    expect(p.interests).toEqual({ food: -1, beach: 1, kitesurf: 2 });
    expect(p.wishlist).toEqual(["Lisbon", "Tarifa"]);
    expect(p.free_windows).toEqual(before.free_windows);
    expect(p.budget.night_max?.amount_minor).toBe(15000);
    expect(p.notes).toHaveLength(1);
    expect(p.notes[0]).toMatchObject({ text: "prefers aisle seats", provenance: { source: "agent", agent: "codex-automation" } });
    expect(Date.parse(p.notes[0]!.provenance.seen_at)).toBe(NOW.getTime());
    // Every key and list item that existed still exists.
    for (const k of Object.keys(before) as (keyof typeof before)[]) expect(p).toHaveProperty(k);

    const again = await call("rumbo_profile_update", { note: "Prefers aisle seats" });
    expect(again.body.notes_added).toBe(0);
    expect(s.getProfile()!.notes).toHaveLength(1);
  });

  it("falls back to the agent of the request, refuses empty and invalid updates and unknown keys", async () => {
    s.putProfile(PROFILE);
    await call("rumbo_profile_update", { note: "likes night trains" }, "grok-task");
    expect(s.getProfile()!.notes[0]!.provenance.agent).toBe("grok-task");
    expect((await call("rumbo_profile_update", {})).body.error).toBe("nothing_to_do");
    expect((await call("rumbo_profile_update", { set: {} })).body.error).toBe("nothing_to_do");
    expect((await call("rumbo_profile_update", { set: { currency: "euro" } })).body.error).toBe("invalid_input");
    expect((await call("rumbo_profile_update", { set: { notes: [] } })).body.error).toBe("invalid_input");
    expect((await call("rumbo_profile_update", { set: { favourite_colour: "teal" } })).body.error).toBe("invalid_input");
  });

  it("needs the basics to create a profile from nothing", async () => {
    expect((await call("rumbo_profile_update", { set: { wishlist: ["Lisbon"] } })).body.error).toBe("invalid_profile");
    const ok = await call("rumbo_profile_update", { set: { home_city: "Valencia", home_airports: ["VLC"] } });
    expect(ok.isError).toBe(false);
    expect(s.getProfile()?.home_city).toBe("Valencia");
    expect((await call("rumbo_profile_get", {})).body.profile.home_city).toBe("Valencia");
  });
});

describe("rumbo_watch_add and rumbo_watch_list", () => {
  it("marks the agent as the creator, keeps owner watches safe and flags due ones", async () => {
    s.upsertWatch(watch("mine", { created_by: "owner" }));
    const r = await call("rumbo_watch_add", { kind: "place-events", label: "Lisbon events", place: "Lisbon", window: { from: "2026-12-01", to: "2026-12-31" }, agent: "claude-scheduled" });
    expect(r.isError).toBe(false);
    expect(r.body.watch).toMatchObject({ created_by: "claude-scheduled", kind: "place-events", active: true, every_hours: 24 });
    expect(r.body.watch.id).toMatch(/^w_/);
    const clash = await call("rumbo_watch_add", { id: "mine", kind: "route", label: "x", window: { from: "2026-12-01", to: "2026-12-31" }, agent: "claude-scheduled" });
    expect(clash.body.error).toBe("not_yours");
    expect(s.getWatch("mine")!.created_by).toBe("owner");
    const list = await call("rumbo_watch_list", {});
    expect(list.body.watches).toHaveLength(2);
    expect(list.body.watches.every((w: any) => w.due === true)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    // The tool has no way to pass created_by.
    const forged = await call("rumbo_watch_add", { kind: "route", label: "y", window: { from: "2026-12-01", to: "2026-12-31" }, created_by: "owner", agent: "grok-task" });
    expect(forged.body.watch.created_by).toBe("grok-task");
  });
});

describe("rumbo_observe", () => {
  const good = (over: Record<string, unknown> = {}) => {
    const { id: _id, ...rest } = fresh("x") as unknown as Record<string, unknown>;
    return { ...rest, provenance: { source: "booking-connector", url: "https://example.com/p", seen_at: "2026-10-23T11:00:00Z", expires_at: "2026-10-25T11:00:00Z" }, ...over };
  };

  it("stores valid rows, derives ids, stamps the agent, and rejects bad rows by index with a reason", async () => {
    const r = await call("rumbo_observe", {
      agent: "claude-scheduled",
      observations: [
        good(),
        { kind: "flight", title: "broken" },
        good({ provenance: { source: "x", seen_at: "2026-10-23T11:00:00Z" } }), // price without a page
        good({ provenance: { source: "x", url: "https://example.com/p", seen_at: "2027-01-01T00:00:00Z" } }), // from the future
        good({ price: { amount_minor: 0, currency: "EUR" } }),
        "not an object",
        good({ depart_date: "2026-12-10", return_date: "2026-12-08" }),
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ accepted: 1, inserted: 1, skipped_older: 0 });
    expect(r.body.rejected.map((x: any) => x.index)).toEqual([1, 2, 3, 4, 5, 6]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.body.rejected[1].error).toMatch(/page it was read on/);
    expect(r.body.rejected[2].error).toMatch(/future/);
    const stored = s.listObservations({ includeStale: true });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toMatch(/^fli_[0-9a-f]{24}$/);
    expect(stored[0]!.provenance.agent).toBe("claude-scheduled");
  });

  it("derives the same id for the same offer, so seeing it again updates it, and reports older sightings", async () => {
    await call("rumbo_observe", { agent: "a1", observations: [good()] });
    const newer = good({ price: { amount_minor: 7000, currency: "EUR" }, provenance: { source: "booking-connector", url: "https://example.com/p", seen_at: "2026-10-23T11:30:00Z" } });
    const second = await call("rumbo_observe", { agent: "a1", observations: [newer] });
    expect(second.body).toMatchObject({ accepted: 1, inserted: 0, updated: 1 });
    const older = good({ price: { amount_minor: 9900, currency: "EUR" }, provenance: { source: "booking-connector", url: "https://example.com/p", seen_at: "2026-10-23T10:00:00Z" } });
    expect((await call("rumbo_observe", { agent: "a1", observations: [older] })).body).toMatchObject({ accepted: 1, skipped_older: 1 });
    const all = s.listObservations({ includeStale: true });
    expect(all).toHaveLength(1);
    expect((all[0] as { price: { amount_minor: number } }).price.amount_minor).toBe(7000);
  });

  it("caps a call at 100 rows and requires an agent name", async () => {
    expect((await call("rumbo_observe", { agent: "a1", observations: Array.from({ length: 101 }, () => good()) })).body.error).toBe("invalid_input");
    expect((await call("rumbo_observe", { observations: [] })).body.error).toBe("invalid_input");
  });

  it("marks watches as run, found or not, and ignores unknown ids", async () => {
    s.upsertWatch(watch("w1"));
    s.upsertWatch(watch("w2"));
    const r = await call("rumbo_observe", { agent: "a1", observations: [good({ watch_id: "w1" })], checked_watch_ids: ["w2", "ghost"] });
    expect(r.body.watches_marked.sort()).toEqual(["w1", "w2"]);
    expect(s.getWatch("w1")!.last_run_at).toBe(NOW.toISOString());
    expect(s.getWatch("w2")!.last_run_at).toBe(NOW.toISOString());
  });

  it("lists the observation shape in tools/list", () => {
    const listed = toolByName("rumbo_observe")!.inputJsonSchema!({ properties: { observations: { type: "array" } } }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(listed.properties.observations.items.oneOf?.length ?? listed.properties.observations.items.anyOf?.length).toBe(6);
  });
});

describe("rumbo_import_history", () => {
  it("upserts valid trips and rejects bad rows", async () => {
    const r = await call("rumbo_import_history", {
      trips: [
        { id: "t1", title: "Lisbon", from: "2025-05-01", to: "2025-05-04", places: ["Lisbon"], rating: 5, tags: ["city"] },
        { id: "t2", title: "Bad", from: "May", to: "2025-05-04", places: [] },
        { id: "t3", title: "Odd tag", from: "2025-06-01", to: "2025-06-04", places: ["Rome"], tags: ["spaceflight"] },
      ],
    });
    expect(r.body.accepted).toBe(1);
    expect(r.body.rejected.map((x: any) => x.index)).toEqual([1, 2]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.listHistory()).toHaveLength(1);
  });
});

describe("rumbo_agent_brief", () => {
  it("lists only the watches that are due, oldest first, and turns them into searches", async () => {
    s.putProfile({ ...PROFILE, wishlist: ["Lisbon"], busy: [{ from: "2026-12-12", to: "2026-12-14" }], free_windows: [{ from: "2026-12-01", to: "2026-12-31" }] });
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    s.upsertWatch(watch("fresh", { last_run_at: hoursAgo(2) }));
    s.upsertWatch(watch("never"));
    s.upsertWatch(watch("overdue", { last_run_at: hoursAgo(30), label: "VLC to OPO", destination: ["OPO"] }));
    s.upsertWatch(watch("off", { active: false }));
    s.upsertWatch(watch("over", { window: { from: "2026-01-01", to: "2026-02-01" } }));
    s.upsertWatch(watch("stays", { kind: "place-stays", place: "Lisbon", destination: [], origin: [], nights: { min: 3, max: 4 } }));

    const brief = (await call("rumbo_agent_brief", { agent: "claude-scheduled", connectors: ["Booking.com", "Kiwi.com"] })).body;
    expect(brief.due_watches.map((w: any) => w.watch_id)).toEqual(["overdue", "never", "stays"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(brief.watches_not_due).toBe(3);
    expect(brief.profile.home.airports).toEqual(["VLC"]);
    expect(brief.profile.busy_days).toHaveLength(1);

    const overdue = brief.due_watches[0];
    expect(overdue.searches[0]).toMatchObject({ connector: "kiwi", available: true, report_as: "flight" });
    expect(overdue.searches[0].params).toMatchObject({ origin: "VLC", destination: "OPO" });
    expect(overdue.searches[0].deep_links.length).toBeGreaterThan(0);
    const stays = brief.due_watches[2];
    expect(stays.searches[0]).toMatchObject({ connector: "booking", report_as: "stay" });
    expect(stays.searches[0].deep_links.map((l: any) => l.label).join()).toMatch(/Booking\.com/); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(brief.rules.join(" ")).toMatch(/Never scrape/);
    expect(brief.rules.join(" ")).toMatch(/never estimate|Never estimate/i);
    expect(Object.keys(brief.report.examples).sort()).toEqual(["activity", "car", "event", "flight", "idea", "stay"]);
  });

  it("falls back to deep links when none of the agent's connectors fits, and to all connectors when unspecified", async () => {
    s.putProfile(PROFILE);
    s.upsertWatch(watch("r1"));
    const only = (await call("rumbo_agent_brief", { agent: "grok-task", connectors: ["Spotify"] })).body;
    expect(only.due_watches[0].searches[0].connector).toBe("deep-link");
    expect(only.due_watches[0].searches[0].ask).toMatch(/Do not guess/);
    const unknown = (await call("rumbo_agent_brief", { agent: "grok-task" })).body;
    expect(unknown.due_watches[0].searches.map((x: any) => x.connector)).toEqual(["kiwi", "expedia"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(unknown.due_watches[0].searches[0].available).toBeNull();
  });

  it("works with no profile and no watches", async () => {
    const b = (await call("rumbo_agent_brief", { agent: "grok-task" })).body;
    expect(b.profile).toBeNull();
    expect(b.due_watches).toEqual([]);
    expect(b.profile_note).toMatch(/No profile/);
  });

  it("is due exactly when every_hours has passed and prefers free Fridays that avoid busy days", () => {
    const w = watch("d", { every_hours: 24, last_run_at: new Date(NOW.getTime() - 24 * 3_600_000).toISOString() });
    expect(isDue(w, NOW)).toBe(true);
    expect(isDue({ ...w, last_run_at: new Date(NOW.getTime() - 23 * 3_600_000).toISOString() }, NOW)).toBe(false);
    const profile = s.putProfile({ ...PROFILE, busy: [{ from: "2026-12-04", to: "2026-12-08" }] });
    const pairs = candidateDates(watch("c", { nights: { min: 3, max: 3 } }), profile, NOW);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThanOrEqual(3);
    for (const p of pairs) {
      expect(new Date(`${p.depart}T00:00:00Z`).getUTCDay()).toBe(5);
      expect(p.depart > "2026-12-08" || p.return < "2026-12-04").toBe(true);
    }
  });

  it("gives examples that the server itself accepts", () => {
    const examples = Object.values(observationExamples(NOW));
    for (const e of examples) expect(ObservationSchema.safeParse({ id: "x", ...e }).success).toBe(true);
    const res = ingestObservations(s, examples, { agent: "example", now: NOW });
    expect(res.rejected).toEqual([]);
    expect(res.accepted).toBe(6);
  });
});

describe("rumbo_to_loco", () => {
  it("returns the loco_propose arguments for a plan and does not change it", async () => {
    s.upsertObservations([fresh("pf")]);
    s.putPlan({
      id: "p1", created_at: NOW.toISOString(), status: "ready",
      request: { window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 3, max: 3 }, interests: [], needs: ["flights"] },
      candidates: [{ place: "Lisbon", country: "Portugal", airports: ["LIS"], score: 0.8, reasons: ["x"] }],
      chosen: "Lisbon", dates: { from: "2026-12-06", to: "2026-12-09" },
      sections: { flights: ["pf"], stay: [], car: [], activities: [], events: [] }, links: [],
    });
    const r = await call("rumbo_to_loco", { plan_id: "p1", trip_slug: "lisbon-dec" });
    expect(r.isError).toBe(false);
    expect(r.body.loco_propose_args.slug).toBe("lisbon-dec");
    expect(r.body.loco_propose_args.proposal).toMatchObject({ createdBy: "rumbo", kind: "other" });
    expect(r.body.loco_propose_args.proposal.options.length).toBeGreaterThan(0);
    expect(s.getPlan("p1")!.status).toBe("ready");
    expect((await call("rumbo_to_loco", { plan_id: "nope" })).body.error).toBe("not_found");
  });
});

describe("rumbo_plan_start, rumbo_plan_get and rumbo_plan_choose", () => {
  const planProfile = () => s.putProfile({ ...PROFILE, home_city: "Valencia", home_airports: ["VLC"], currency: "EUR" });

  it("asks for a profile first and for some input", async () => {
    const none = await call("rumbo_plan_start", { text: "a week in Lisbon" });
    expect(none.isError).toBe(true);
    expect(none.body.error).toBe("no_profile");
    planProfile();
    const empty = await call("rumbo_plan_start", {});
    expect(empty.body.error).toBe("invalid_input");
    expect((await call("rumbo_plan_start", { text: "   " })).body.error).toBe("invalid_input");
  });

  it("starts from a sentence, ranks places with fares from the sources, and tells the agent to ask the owner", async () => {
    planProfile();
    const r = await call("rumbo_plan_start", { text: "5 nights of food and culture in December" }, "claude-scheduled");
    expect(r.isError).toBe(false);
    const plan = r.body.plan;
    expect(plan.id).toMatch(/^pl_/);
    expect(plan.status).toBe("choosing");
    expect(plan.candidates.length).toBeGreaterThan(1);
    expect(plan.candidates.some((c: any) => c.cheapest_flight?.source === "fake-fares")).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(plan.source_notices.some((n: any) => n.source === "fake-fares" && n.ok)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.body.next).toMatch(/Ask the owner/);
    expect(s.getPlan(plan.id)?.request.text).toBe("5 nights of food and culture in December");
  });

  it("lets structured fields win over the sentence, and goes straight to a named place", async () => {
    planProfile();
    const r = await call("rumbo_plan_start", { text: "a week somewhere", destination: "Lisbon", nights: { min: 3, max: 3 }, window: { from: "2026-12-01", to: "2026-12-10" } });
    expect(r.isError).toBe(false);
    expect(r.body.plan.request).toMatchObject({ destination: "Lisbon", nights: { min: 3, max: 3 }, origin: ["VLC"] });
    expect(r.body.plan.status).toBe("ready");
    expect(r.body.plan.chosen).toBe("Lisbon");
    expect(r.body.plan.sections.stay.length).toBeGreaterThan(0);
    const stay = r.body.plan.sections.stay[0];
    expect(stay).toMatchObject({ source: "fake-stays", stale: false });
    expect(stay.price.text).toMatch(/^€/);
    expect(stay.url).toMatch(/^https:/);
  });

  it("reads a plan back, lists plans, and answers not_found", async () => {
    planProfile();
    const started = await call("rumbo_plan_start", { text: "5 nights of food and culture in December" });
    const got = await call("rumbo_plan_get", { plan_id: started.body.plan.id });
    expect(got.isError).toBe(false);
    expect(got.body.plan).toEqual(started.body.plan);
    const list = await call("rumbo_plan_get", {});
    expect(list.body).toMatchObject({ count: 1, plans: [{ id: started.body.plan.id, status: "choosing" }] });
    expect((await call("rumbo_plan_get", { plan_id: "pl_missing" })).body.error).toBe("not_found");
  });

  it("chooses a place with the owner's dates, fills the sections, and refuses a half pair of dates", async () => {
    planProfile();
    const started = await call("rumbo_plan_start", { text: "5 nights of food and culture in December" });
    const place = started.body.plan.candidates[0].place as string;
    expect((await call("rumbo_plan_choose", { plan_id: started.body.plan.id, place, from: "2026-12-05" })).body.error).toBe("invalid_input");
    const r = await call("rumbo_plan_choose", { plan_id: started.body.plan.id, place, from: "2026-12-05", to: "2026-12-09" });
    expect(r.isError).toBe(false);
    expect(r.body.plan).toMatchObject({ status: "ready", chosen: place, dates: { from: "2026-12-05", to: "2026-12-09" } });
    expect(r.body.plan.sections.stay.length).toBeGreaterThan(0);
    expect(r.body.plan.links.length).toBeGreaterThan(0);
    expect(r.body.next).toMatch(/rumbo_to_loco/);
    // The plan feeds rumbo_to_loco as it is.
    const loco = await call("rumbo_to_loco", { plan_id: r.body.plan.id, trip_slug: "t" });
    expect(loco.isError).toBe(false);
  });

  it("maps planner errors to tool errors: past dates, unknown plan, archived plan", async () => {
    planProfile();
    const started = await call("rumbo_plan_start", { text: "5 nights of food and culture in December" });
    const id = started.body.plan.id as string;
    expect((await call("rumbo_plan_choose", { plan_id: id, place: "Lisbon", from: "2026-09-01", to: "2026-09-05" })).body).toMatchObject({ error: "bad_request" });
    expect((await call("rumbo_plan_choose", { plan_id: "pl_missing", place: "Lisbon" })).body.error).toBe("not_found");
    s.putPlan({ ...s.getPlan(id)!, status: "archived" }, NOW);
    expect((await call("rumbo_plan_choose", { plan_id: id, place: "Lisbon" })).isError).toBe(true);
    expect((await call("rumbo_plan_get", {})).body.count).toBe(0);
    expect((await call("rumbo_plan_get", { include_archived: true })).body.count).toBe(1);
  });
});

describe("agent activity", () => {
  it("groups the newest observations by agent with counts and last seen", () => {
    ingestObservations(s, [fresh("a", { id: undefined })], { agent: "claude-scheduled", now: NOW });
    s.upsertObservations([fresh("server-row")]);
    const act = recentAgentActivity(s, 20);
    expect(act.map((a) => a.agent).sort()).toEqual(["claude-scheduled", "server"]);
    expect(act.find((a) => a.agent === "claude-scheduled")!.count).toBe(1);
  });

  it("keeps the id stable across calls", () => {
    const o = ObservationSchema.parse(fresh("x"));
    expect(observationId(o)).toBe(observationId({ ...o, title: "another title" }));
  });
});

// --- review round: ids, ownership, published schema, expired watches ---------------------------------

const leg = (from: string, to: string, no: string, dep: string) => ({ from, to, carrier: no.slice(0, 2), flight_no: no, depart_at: dep, arrive_at: dep.replace("T08", "T10") });

describe("flight ids from agents", () => {
  const post = (rows: unknown[]) => ingestObservations(s, rows, { agent: "claude-scheduled", now: NOW });

  it("keeps two itineraries on one route, date, seller and stop count apart, and updates only an exact repeat", () => {
    const a = fresh("x", { id: undefined, seller: "Kiwi.com", legs: [leg("VLC", "LIS", "TP1097", "2026-12-06T08:00:00+01:00")] });
    const b = fresh("x", { id: undefined, seller: "Kiwi.com", legs: [leg("VLC", "LIS", "TP1099", "2026-12-06T18:00:00+01:00")] });
    const r1 = post([a, b]);
    expect(r1).toMatchObject({ inserted: 2, rejected: [] });
    expect(s.listStoredObservations({ limit: 10, includeStale: true })).toHaveLength(2);
    // The same itinerary again, cheaper: one row, updated.
    const r2 = post([{ ...a, price: { amount_minor: 7000, currency: "EUR" }, provenance: { ...(a as any).provenance, seen_at: "2026-10-23T11:00:00Z" } }]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r2).toMatchObject({ inserted: 0, updated: 1 });
    expect(s.listStoredObservations({ limit: 10, includeStale: true })).toHaveLength(2);
  });

  it("uses the collectors' id for the same legs, so a collector and an agent meet on one row", () => {
    const legs = [leg("VLC", "LIS", "TP1097", "2026-12-06T08:00:00+01:00")];
    const o = ObservationSchema.parse(fresh("x", { legs }));
    expect(observationId(o)).toBe(flightId({
      origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-09",
      legs: [legKey({ carrier: "TP", number: "TP1097", from: "VLC", to: "LIS", departLocal: "2026-12-06T08:00:00+01:00" })],
    }));
  });

  it("tells legless offers apart by seller and book page, and a leg without a number by its departure time", () => {
    const base = { id: undefined, legs: [] as unknown[] };
    const rows = [
      fresh("x", { ...base, seller: "Ryanair (direct)" }),
      fresh("x", { ...base, seller: "Kiwi.com" }),
      fresh("x", { ...base, seller: "Kiwi.com", book_url: "https://example.com/other" }),
      fresh("x", { ...base, price: { amount_minor: 8900, currency: "GBP" } }),
    ];
    expect(post(rows)).toMatchObject({ inserted: 4, rejected: [] });
    const noNo = (t: string) => fresh("x", { id: undefined, legs: [{ from: "VLC", to: "LIS", carrier: "Vueling", depart_at: t, arrive_at: t }] });
    const ids = [noNo("2026-12-06T08:00:00+01:00"), noNo("2026-12-06T18:00:00+01:00")].map((r) => observationId(ObservationSchema.parse({ ...r, id: "p" })));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("rumbo_watch_add ownership", () => {
  const win = { from: "2026-12-01", to: "2026-12-31" };

  it("refuses the owner's name from any agent, in the argument and in the request", async () => {
    s.upsertWatch(watch("mine", { created_by: "owner", label: "owner's" }));
    for (const agent of ["owner", "Owner", " OWNER "]) {
      const r = await call("rumbo_watch_add", { id: "mine", kind: "route", label: "taken over", window: win, agent });
      expect(r.body.error).toBe("reserved_agent");
    }
    expect((await call("rumbo_watch_add", { kind: "route", label: "x", window: win }, "owner")).body.error).toBe("reserved_agent");
    expect(s.getWatch("mine")).toMatchObject({ created_by: "owner", label: "owner's" });
    expect(s.listWatches()).toHaveLength(1);
  });

  it("creates only with a server-generated id and updates only its own watches", async () => {
    const made = await call("rumbo_watch_add", { kind: "route", label: "mine", window: win, agent: "grok-task" });
    const id = made.body.watch.id as string;
    expect((await call("rumbo_watch_add", { id: "chosen-by-agent", kind: "route", label: "x", window: win, agent: "grok-task" })).body.error).toBe("not_found");
    const own = await call("rumbo_watch_add", { id, kind: "route", label: "renamed", window: win, agent: "grok-task" });
    expect(own.body).toMatchObject({ created: false, watch: { label: "renamed", created_by: "grok-task" } });
    expect((await call("rumbo_watch_add", { id, kind: "route", label: "stolen", window: win, agent: "codex-automation" })).body.error).toBe("not_yours");
    expect(s.getWatch(id)!.label).toBe("renamed");
  });
});

describe("the published rumbo_observe schema", () => {
  it("accepts every example of the brief, which carry no id", () => {
    const tool = listedTools().find((t) => t.name === "rumbo_observe")!;
    const schema = (tool.inputSchema as unknown as { properties: { observations: { items: unknown } } }).properties.observations.items;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema as object);
    const examples = Object.entries(observationExamples(NOW));
    expect(examples).toHaveLength(6);
    for (const [kind, row] of examples) {
      expect((row as Record<string, unknown>).id, kind).toBeUndefined();
      expect(validate(row), `${kind}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
    // The schema still insists on the rest: a row without a title is refused.
    expect(validate({ ...(examples[0]![1] as object), title: undefined })).toBe(false);
  });
});

describe("watches whose window is over", () => {
  it("clamps dates to the window, and a watch with no day left is expired, not due", async () => {
    const today = "2026-10-23";
    const ends = watch("ends", { window: { from: "2026-10-01", to: today } });
    expect(candidateDates(ends, null, NOW)).toEqual([]);
    expect(isDue(ends, NOW)).toBe(false);
    const tomorrow = watch("tomorrow", { window: { from: "2026-10-01", to: "2026-10-24" } });
    expect(candidateDates(tomorrow, null, NOW).every((p) => p.depart >= "2026-10-24" && p.depart <= "2026-10-24")).toBe(true);
    expect(isDue(tomorrow, NOW)).toBe(true);
    // Every day busy: the fallback is still a day inside the window.
    const profile = s.putProfile({ ...PROFILE, busy: [{ from: "2026-10-20", to: "2026-12-31" }] });
    const fb = candidateDates(watch("busy", { window: { from: "2026-10-01", to: "2026-11-10" } }), profile, NOW);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.depart >= "2026-10-24" && fb[0]!.depart <= "2026-11-10").toBe(true);

    s.upsertWatch(ends);
    s.upsertWatch(watch("live"));
    const brief = (await call("rumbo_agent_brief", { agent: "claude-scheduled" })).body;
    expect(brief.due_watches.map((w: any) => w.watch_id)).toEqual(["live"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(brief.expired_watches).toEqual([expect.objectContaining({ watch_id: "ends", window_to: today })]);
    expect(brief.expired_watches[0].note).toMatch(/expired/i);
  });
});
