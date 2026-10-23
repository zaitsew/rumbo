import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WATCHES_PER_COLLECT, collectDue, isDue } from "../src/server/collect";
import { ProfileSchema } from "../src/core/schema";
import { createStore, listRuns, openDb, type Db, type Store } from "../src/server/store";
import { NOW, fakeEvents, fakeFlights, fakeSource, memoryLedger } from "./plan-support";
import { tempDir, watch } from "./helpers";

let db: Db;
let store: Store;
beforeEach(() => {
  db = openDb(":memory:");
  store = createStore(db);
  store.putProfile(ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], currency: "EUR" }), NOW);
});
afterEach(() => db.close());

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("isDue", () => {
  it("is due when never run, when the interval has passed, and when the stamp is unreadable", () => {
    expect(isDue(24, undefined, NOW)).toBe(true);
    expect(isDue(24, hoursAgo(25), NOW)).toBe(true);
    expect(isDue(24, hoursAgo(24), NOW)).toBe(true);
    expect(isDue(24, hoursAgo(23), NOW)).toBe(false);
    expect(isDue(24, "garbage", NOW)).toBe(true);
  });
});

describe("collectDue", () => {
  it("runs only the watches that are due and active, stores their findings with the watch id, and stamps last_run_at", async () => {
    store.upsertWatch(watch("never", { window: { from: "2026-12-01", to: "2026-12-03" } }));
    store.upsertWatch(watch("old", { every_hours: 6, last_run_at: hoursAgo(7), window: { from: "2026-12-01", to: "2026-12-03" } }));
    store.upsertWatch(watch("fresh", { every_hours: 6, last_run_at: hoursAgo(2) }));
    store.upsertWatch(watch("paused", { active: false }));
    const flights = fakeFlights();
    const r = await collectDue("owner", NOW, { store, sources: [flights], env: {}, ledger: memoryLedger() });

    expect(r).toEqual({ watches_run: 2, observations: 2, calls: 2 }); // both watches see the same LIS offer: one inserted, one refreshed
    expect(flights.queries).toHaveLength(2);
    expect(store.getWatch("never")!.last_run_at).toBe(NOW.toISOString());
    expect(store.getWatch("old")!.last_run_at).toBe(NOW.toISOString());
    expect(store.getWatch("fresh")!.last_run_at).toBe(hoursAgo(2)); // untouched
    expect(store.getWatch("paused")!.last_run_at).toBeUndefined();
    const stored = store.listObservations({ now: NOW });
    expect(stored).toHaveLength(1);
    expect(["never", "old"]).toContain(stored[0]!.watch_id);
  });

  it("does nothing when nothing is due, and records no run", async () => {
    store.upsertWatch(watch("fresh", { last_run_at: hoursAgo(1) }));
    const flights = fakeFlights();
    expect(await collectDue("owner", NOW, { store, sources: [flights], env: {} })).toEqual({ watches_run: 0, observations: 0, calls: 0 });
    expect(flights.queries).toHaveLength(0);
    expect(listRuns(db)).toEqual([]);
  });

  it("records a run that /usage can read", async () => {
    store.upsertWatch(watch("a"));
    await collectDue("owner", NOW, { store, sources: [fakeFlights()], env: {}, ledger: memoryLedger() });
    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "collect", ok: true, calls: 1 });
    expect(store.usage(NOW).last_collect_at).not.toBe("never");
  });

  it("respects each source's daily cap: the watch the cap blocks is not stamped and is tried again", async () => {
    store.upsertWatch(watch("w1", { label: "one" }));
    store.upsertWatch(watch("w2", { label: "two", destination: ["PRG"] }));
    const capped = fakeFlights("capped", { dailyCap: 1 });
    const ledger = memoryLedger();
    const first = await collectDue("owner", NOW, { store, sources: [capped], env: {}, ledger });
    expect(first.watches_run).toBe(1);
    expect(first.calls).toBe(1);
    expect(capped.queries).toHaveLength(1);
    const blocked = store.listWatches().filter((w) => !w.last_run_at);
    expect(blocked).toHaveLength(1);
    // Next day the cap resets and the blocked watch runs.
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    const second = await collectDue("owner", tomorrow, { store, sources: [capped], env: {}, ledger });
    expect(second.watches_run).toBe(1); // the cap is 1 a day again; the watch that never ran goes first
    expect(store.listWatches().every((w) => w.last_run_at)).toBe(true);
  });

  it("stamps a watch whose source failed (so the batch moves on), keeps the error in the run, and leaves an all-off watch alone", async () => {
    store.upsertWatch(watch("a", { label: "Lisbon fares" }));
    const broken = fakeSource({ name: "broken", kinds: ["flight"], search: () => { throw new Error("HTTP 500"); } });
    const r = await collectDue("owner", NOW, { store, sources: [broken], env: {}, ledger: memoryLedger() });
    expect(r).toMatchObject({ watches_run: 0, observations: 0 });
    expect(store.getWatch("a")!.last_run_at).toBe(NOW.toISOString()); // attempted: waits its interval
    expect(listRuns(db)[0]!.error).toMatch(/Lisbon fares \/ broken: HTTP 500/);

    store.upsertWatch(watch("b", { label: "Prague fares", destination: ["PRG"] }));
    const off = fakeFlights("off", { enabled: false });
    expect((await collectDue("owner", NOW, { store, sources: [off], env: {}, ledger: memoryLedger() })).watches_run).toBe(0);
    expect(store.getWatch("b")!.last_run_at).toBeUndefined(); // nothing was called: no stamp
  });

  it("does not let watches without an enabled source take the batch from a runnable one", async () => {
    for (let i = 0; i < MAX_WATCHES_PER_COLLECT; i++) store.upsertWatch(watch(`a${String(i).padStart(2, "0")}`, { kind: "place-events", place: "Valencia", origin: [], destination: [] }));
    store.upsertWatch(watch("zz-route", { last_run_at: hoursAgo(30) })); // older stamp than "never": would sort after them
    const events = fakeEvents("sawk-fake", { enabled: false });
    const flights = fakeFlights();
    const r = await collectDue("owner", NOW, { store, sources: [flights, events], env: {}, ledger: memoryLedger() });
    expect(r.watches_run).toBe(1);
    expect(store.getWatch("zz-route")!.last_run_at).toBe(NOW.toISOString());
  });

  it("rotates the batch: watches that failed are stamped, so the next call reaches the ones behind them", async () => {
    const total = MAX_WATCHES_PER_COLLECT + 3;
    for (let i = 0; i < total; i++) store.upsertWatch(watch(`w${String(i).padStart(2, "0")}`));
    const broken = fakeSource({ name: "broken", kinds: ["flight"], search: () => { throw new Error("HTTP 500"); } });
    await collectDue("owner", NOW, { store, sources: [broken], env: {}, ledger: memoryLedger() });
    expect(store.listWatches().filter((w) => !w.last_run_at)).toHaveLength(3);
    const flights = fakeFlights();
    await collectDue("owner", NOW, { store, sources: [flights], env: {}, ledger: memoryLedger() });
    expect(flights.queries).toHaveLength(3);
    expect(store.listWatches().every((w) => w.last_run_at)).toBe(true);
  });

  it("writes only the run time: an edit, a pause or a delete made during the run survives", async () => {
    store.upsertWatch(watch("edit", { label: "before", destination: ["LIS"] }));
    store.upsertWatch(watch("pause", { destination: ["PRG"] }));
    store.upsertWatch(watch("gone", { destination: ["ATH"] }));
    const meddling = fakeSource({
      name: "meddling",
      kinds: ["flight"],
      search: async () => {
        // The owner edits, pauses and deletes while the collector waits on the source.
        const edit = store.getWatch("edit");
        if (edit) store.upsertWatch({ ...edit, label: "after", every_hours: 3 });
        const pause = store.getWatch("pause");
        if (pause) store.upsertWatch({ ...pause, active: false });
        store.deleteWatch("gone");
        return [];
      },
    });
    await collectDue("owner", NOW, { store, sources: [meddling], env: {}, ledger: memoryLedger() });
    expect(store.getWatch("edit")).toMatchObject({ label: "after", every_hours: 3, last_run_at: NOW.toISOString() });
    expect(store.getWatch("pause")).toMatchObject({ active: false });
    expect(store.getWatch("gone")).toBeNull();
  });

  it("sends place-events watches to the events source", async () => {
    store.upsertWatch(watch("ev", { kind: "place-events", label: "Valencia events", place: "Valencia", origin: [], destination: [], window: { from: "2026-12-01", to: "2026-12-07" } }));
    const events = fakeEvents("sawk-fake");
    const flights = fakeFlights();
    const r = await collectDue("owner", NOW, { store, sources: [flights, events], env: {}, ledger: memoryLedger() });
    expect(events.queries).toEqual([{ kind: "events", place: "Valencia", country: "ES", window: { from: "2026-12-01", to: "2026-12-07" } }]);
    expect(flights.queries).toHaveLength(0);
    expect(r.watches_run).toBe(1);
    expect(store.listObservations({ kinds: ["event"], now: NOW }).every((o) => o.watch_id === "ev")).toBe(true);
  });

  it("skips a watch with nothing to search and does nothing without a profile", async () => {
    store.upsertWatch(watch("nothing", { kind: "route", destination: [] }));
    const flights = fakeFlights();
    expect((await collectDue("owner", NOW, { store, sources: [flights], env: {} })).watches_run).toBe(0);
    expect(flights.queries).toHaveLength(0);
    const bare = createStore(openDb(":memory:"), "nobody");
    expect(await collectDue("nobody", NOW, { store: bare, sources: [flights], env: {} })).toEqual({ watches_run: 0, observations: 0, calls: 0 });
  });

  it("runs the oldest watches first and at most 25 per call", async () => {
    for (let i = 0; i < MAX_WATCHES_PER_COLLECT + 5; i++) store.upsertWatch(watch(`w${String(i).padStart(2, "0")}`, { last_run_at: hoursAgo(30 + i) }));
    const r = await collectDue("owner", NOW, { store, sources: [fakeFlights()], env: {}, ledger: memoryLedger() });
    expect(r.watches_run).toBe(MAX_WATCHES_PER_COLLECT);
    const untouched = store.listWatches().filter((w) => w.last_run_at !== NOW.toISOString());
    expect(untouched).toHaveLength(5);
    expect(untouched.map((w) => w.id).sort()).toEqual(["w00", "w01", "w02", "w03", "w04"]); // the most recently run ones wait
  });

  it("shares one run between two overlapping calls", async () => {
    store.upsertWatch(watch("a"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeSource({ name: "slow", kinds: ["flight"], search: async () => { await gate; return []; } });
    const one = collectDue("owner", NOW, { store, sources: [slow], env: {}, ledger: memoryLedger() });
    const two = collectDue("owner", NOW, { store, sources: [slow], env: {}, ledger: memoryLedger() });
    release();
    expect(await two).toBe(await one);
    expect(slow.queries).toHaveLength(1);
  });
});

describe("POST /api/v1/collect", () => {
  const KEY = "collect-test-key";
  const tmp = tempDir();
  let post: (req: Request) => Promise<Response>;
  let closeDb: () => void;
  beforeAll(async () => {
    process.env.RUMBO_DB = tmp.path;
    process.env.RUMBO_OWNER_KEY = KEY;
    process.env.RUMBO_TRUST_PROXY = "1";
    vi.resetModules();
    post = (await import("../app/api/v1/collect/route")).POST as never;
    closeDb = (await import("../src/server/store")).closeDb;
  });
  afterAll(() => {
    closeDb();
    tmp.cleanup();
  });
  const req = (key?: string) => new Request("http://localhost:3000/api/v1/collect", { method: "POST", headers: key ? { authorization: `Bearer ${key}`, "x-forwarded-for": "7.7.7.7" } : { "x-forwarded-for": "7.7.7.7" } });

  it("needs the owner key", async () => {
    expect((await post(req())).status).toBe(401);
    expect((await post(req("wrong"))).status).toBe(401);
  });

  it("answers with the counts for the owner", async () => {
    const res = await post(req(KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watches_run: 0, observations: 0, calls: 0 });
  });
});
