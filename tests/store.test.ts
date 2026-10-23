import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, createCallLedger, createStore, listRuns, openDb, recordRun, type Db, type Store } from "../src/server/store";
import { PROFILE, flight, tempDir, watch } from "./helpers";

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

describe("database", () => {
  it("uses WAL and applies every migration once", () => {
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);
    db.close();
    db = openDb(tmp.path); // reopening applies nothing twice
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    s = createStore(db);
  });

  it("refuses a database from a newer build", () => {
    db.close();
    const raw = new DatabaseSync(tmp.path);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openDb(tmp.path)).toThrow(/newer build/);
    db = openDb(":memory:");
    s = createStore(db);
  });

  it("puts user_id on every per-user table", () => {
    for (const t of ["profile", "history", "watches", "observations", "feedback", "plans"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, t).toContain("user_id");
    }
  });
});

describe("profile", () => {
  it("is null until written, then round-trips with defaults filled", () => {
    expect(s.getProfile()).toBeNull();
    s.putProfile(PROFILE);
    const p = s.getProfile()!;
    expect(p.home_airports).toEqual(["VLC"]);
    expect(p.currency).toBe("EUR");
    expect(p.interests.food).toBe(2);
  });

  it("rejects an invalid profile and keeps the old one", () => {
    s.putProfile(PROFILE);
    expect(() => s.putProfile({ home_city: "X", home_airports: [] })).toThrow();
    expect(s.getProfile()!.home_city).toBe("Valencia");
  });

  it("is per user", () => {
    s.putProfile(PROFILE);
    expect(createStore(db, "someone-else").getProfile()).toBeNull();
  });
});

describe("watches", () => {
  it("upserts, lists in creation order and deletes", () => {
    s.upsertWatch(watch("w1"));
    s.upsertWatch(watch("w2", { label: "second" }));
    s.upsertWatch(watch("w1", { label: "renamed", active: false }));
    const list = s.listWatches();
    expect(list.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(list[0]!.label).toBe("renamed");
    expect(list[0]!.active).toBe(false);
    expect(s.deleteWatch("w1")).toBe(true);
    expect(s.deleteWatch("w1")).toBe(false);
    expect(s.listWatches()).toHaveLength(1);
  });
});

describe("observations", () => {
  it("upserts by id and keeps the first seen_at", () => {
    expect(s.upsertObservations([flight("a")])).toEqual({ inserted: 1, updated: 0, skipped_older: 0 });
    const again = flight("a", {
      price: { amount_minor: 7000, currency: "EUR" },
      provenance: { source: "kiwi-mcp", seen_at: "2026-10-24T08:00:00+02:00", expires_at: "2026-10-26T08:00:00+02:00" },
    });
    expect(s.upsertObservations([again])).toEqual({ inserted: 0, updated: 1, skipped_older: 0 });
    const [row] = s.listStoredObservations({ now: new Date("2026-10-24T09:00:00Z") });
    expect(row!.first_seen_at).toBe("2026-10-23T06:00:00.000Z");
    expect(row!.seen_at).toBe("2026-10-24T06:00:00.000Z");
    expect(row!.observation.kind === "flight" && row!.observation.price.amount_minor).toBe(7000);
  });

  it("never lets an older observation overwrite a newer one", () => {
    const at = (iso: string, cents: number) =>
      flight("a", { price: { amount_minor: cents, currency: "EUR" }, provenance: { source: "kiwi-mcp", seen_at: iso } });
    s.upsertObservations([at("2026-10-24T10:00:00Z", 7000)]);
    expect(s.upsertObservations([at("2026-10-23T10:00:00Z", 9900)])).toEqual({ inserted: 0, updated: 0, skipped_older: 1 });
    const [row] = s.listStoredObservations({ includeStale: true });
    expect(row!.observation.kind === "flight" && row!.observation.price.amount_minor).toBe(7000);
    expect(row!.seen_at).toBe("2026-10-24T10:00:00.000Z");
    // the same instant is not older: it updates; first_seen_at stays at the first insert
    expect(s.upsertObservations([at("2026-10-24T10:00:00Z", 6500)])).toEqual({ inserted: 0, updated: 1, skipped_older: 0 });
    // a batch is applied in order: the older duplicate inside one call loses to the newer one before it
    expect(s.upsertObservations([at("2026-10-25T10:00:00Z", 6000), at("2026-10-24T12:00:00Z", 5000)])).toEqual({ inserted: 0, updated: 1, skipped_older: 1 });
    const [after] = s.listStoredObservations({ includeStale: true });
    expect(after!.observation.kind === "flight" && after!.observation.price.amount_minor).toBe(6000);
    expect(after!.first_seen_at).toBe("2026-10-24T10:00:00.000Z");
  });

  it("rolls the whole batch back when one observation is invalid", () => {
    expect(() => s.upsertObservations([flight("a"), { kind: "flight", id: "b" }])).toThrow();
    expect(s.listObservations({ includeStale: true })).toHaveLength(0);
  });

  it("filters by kind, since and staleness, newest first", () => {
    const idea = {
      kind: "idea", id: "i1", title: "Kite week", place: "Tarifa", summary: "Wind in March",
      provenance: { source: "claude", seen_at: "2026-10-22T10:00:00Z" },
    };
    s.upsertObservations([
      flight("old", { provenance: { source: "x", seen_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-02T00:00:00Z" } }),
      flight("fresh"),
      idea,
    ]);
    const now = new Date("2026-10-23T12:00:00Z");
    expect(s.listObservations({ now }).map((o) => o.id)).toEqual(["fresh", "i1"]); // no expiry means never stale
    expect(s.listObservations({ now, includeStale: true }).map((o) => o.id)).toEqual(["fresh", "i1", "old"]);
    expect(s.listObservations({ now, kinds: ["idea"] }).map((o) => o.id)).toEqual(["i1"]);
    expect(s.listObservations({ now, includeStale: true, since: "2026-10-22T00:00:00Z" }).map((o) => o.id)).toEqual(["fresh", "i1"]);
  });

  it("skips a row that no longer matches the schema instead of failing the list", () => {
    s.upsertObservations([flight("a"), flight("b")]);
    db.prepare("UPDATE observations SET json = '{\"kind\":\"flight\"}' WHERE id = 'b'").run();
    expect(s.listObservations({ includeStale: true }).map((o) => o.id)).toEqual(["a"]);
  });
});

describe("feedback, history, plans", () => {
  it("stores feedback in order and filters by observation", () => {
    s.addFeedback({ observation_id: "a", action: "saved" }, new Date("2026-10-23T10:00:00Z"));
    s.addFeedback({ observation_id: "b", action: "dismissed", note: "too far" }, new Date("2026-10-23T11:00:00Z"));
    expect(s.listFeedback().map((f) => f.action)).toEqual(["saved", "dismissed"]);
    expect(s.listFeedback({ observationId: "b" })[0]).toMatchObject({ note: "too far", at: "2026-10-23T11:00:00.000Z" });
    expect(() => s.addFeedback({ observation_id: "a", action: "nope" })).toThrow();
  });

  it("upserts history by id, newest trip first", () => {
    const trip = (id: string, from: string) => ({ id, title: id, from, to: from, places: ["Lisbon"] });
    s.upsertHistory([trip("t1", "2025-05-01"), trip("t2", "2026-01-01")]);
    s.upsertHistory([{ ...trip("t1", "2025-05-01"), rating: 5 }]);
    const h = s.listHistory();
    expect(h.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(h[1]!.rating).toBe(5);
  });

  it("round-trips a plan", () => {
    const plan = {
      id: "p1", created_at: "2026-10-23T10:00:00Z", status: "choosing",
      request: { window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 3, max: 4 } },
      candidates: [], sections: {}, links: [],
    };
    s.putPlan(plan, new Date("2026-10-23T10:00:00Z"));
    s.putPlan({ ...plan, id: "p2" }, new Date("2026-10-23T11:00:00Z"));
    expect(s.getPlan("p1")!.request.interests).toEqual([]);
    expect(s.getPlan("nope")).toBeNull();
    expect(s.listPlans().map((p) => p.id)).toEqual(["p2", "p1"]);
  });
});

describe("call ledger, runs and usage", () => {
  it("counts per source and day", () => {
    const ledger = createCallLedger(db);
    expect(ledger.count("kiwi-mcp", "2026-10-23")).toBe(0);
    ledger.add("kiwi-mcp", "2026-10-23", 3);
    ledger.add("kiwi-mcp", "2026-10-23", 2);
    ledger.add("kiwi-mcp", "2026-10-24", 1);
    expect(ledger.count("kiwi-mcp", "2026-10-23")).toBe(5);
    expect(ledger.count("kiwi-mcp", "2026-10-24")).toBe(1);
    expect(ledger.count("other", "2026-10-23")).toBe(0);
    expect(() => ledger.add("kiwi-mcp", "2026-10-23", -1)).toThrow();
  });

  it("keeps the ledger across reopening the file", () => {
    createCallLedger(db).add("kiwi-mcp", "2026-10-23", 7);
    db.close();
    db = openDb(tmp.path);
    s = createStore(db);
    expect(createCallLedger(db).count("kiwi-mcp", "2026-10-23")).toBe(7);
  });

  it("reports usage counters", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(s.usage(now)).toMatchObject({ observations: 0, watches_active: 0, last_collect_at: "never" });
    s.upsertObservations([flight("a"), flight("b", { provenance: { source: "x", seen_at: "2026-09-01T00:00:00Z" } })]);
    s.upsertWatch(watch("w1"));
    s.upsertWatch(watch("w2", { active: false }));
    s.addFeedback({ observation_id: "a", action: "saved" }, now);
    recordRun(db, { id: "r1", source: "kiwi-mcp", started_at: "2026-10-23T11:00:00Z", finished_at: "2026-10-23T11:00:05Z", calls: 4, ok: true, error: null });
    recordRun(db, { id: "r2", source: "kiwi-mcp", started_at: "2026-10-23T11:30:00Z", finished_at: "2026-10-23T11:30:01Z", calls: 0, ok: false, error: "boom" });
    expect(s.usage(now)).toEqual({
      observations: 2, observations_7d: 1, watches_active: 1, plans: 0, feedback_7d: 1,
      last_collect_at: "2026-10-23T11:00:05.000Z",
    });
    expect(listRuns(db).map((r) => r.id)).toEqual(["r2", "r1"]);
  });
});
