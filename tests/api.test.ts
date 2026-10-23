import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flight, tempDir, PROFILE, watch } from "./helpers";

const KEY = "test-owner-key";
const tmp = tempDir();
const BASE = "http://localhost:3000/api/v1";

type Mod = Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
const mods: Record<string, Mod> = {};
let closeDb: () => void;

function req(path: string, init: RequestInit & { key?: string | null } = {}): Request {
  const { key = KEY, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { ...rest, headers });
}
const json = (v: unknown) => JSON.stringify(v);

beforeAll(async () => {
  process.env.RUMBO_DB = tmp.path;
  process.env.RUMBO_OWNER_KEY = KEY;
  process.env.RUMBO_TRUST_PROXY = "1"; // Caddy's X-Forwarded-For names the client
  vi.resetModules();
  mods.profile = (await import("../app/api/v1/profile/route")) as unknown as Mod;
  mods.watches = (await import("../app/api/v1/watches/route")) as unknown as Mod;
  mods.watch = (await import("../app/api/v1/watches/[id]/route")) as unknown as Mod;
  mods.observations = (await import("../app/api/v1/observations/route")) as unknown as Mod;
  mods.feedback = (await import("../app/api/v1/feedback/route")) as unknown as Mod;
  mods.history = (await import("../app/api/v1/history/route")) as unknown as Mod;
  mods.plans = (await import("../app/api/v1/plans/route")) as unknown as Mod;
  mods.plan = (await import("../app/api/v1/plans/[id]/route")) as unknown as Mod;
  mods.health = (await import("../app/api/v1/health/route")) as unknown as Mod;
  closeDb = (await import("../src/server/store")).closeDb;
});
afterAll(() => {
  closeDb();
  tmp.cleanup();
});
beforeEach(async () => {
  const { store } = await import("../src/server/store");
  const s = store();
  for (const w of s.listWatches()) s.deleteWatch(w.id);
});

describe("auth on the API", () => {
  it("answers 401 with the error shape when there is no key, and 401 for a wrong one", async () => {
    const none = await mods.profile!.GET!(req("/profile", { key: null }));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthorized" });
    const wrong = await mods.profile!.GET!(req("/profile", { key: "nope" }));
    expect(wrong.status).toBe(401);
  });

  it("locks an address out after ten wrong keys, even for the right key, and spares others", async () => {
    const from = (ip: string, key: string) => req("/watches", { key, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 10; i++) expect((await mods.watches!.GET!(from("9.9.9.9", "bad"))).status).toBe(401);
    expect((await mods.watches!.GET!(from("9.9.9.9", "bad"))).status).toBe(429);
    expect((await mods.watches!.GET!(from("9.9.9.9", KEY))).status).toBe(429);
    expect((await mods.watches!.GET!(from("8.8.8.8", KEY))).status).toBe(200);
  });

  it("refuses everything with 503 not_configured when no owner key is set, but keeps health open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.RUMBO_OWNER_KEY;
    try {
      const spoof = { host: "localhost:3000", "x-forwarded-for": "127.0.0.1" };
      for (const m of [mods.profile!.GET!, mods.watches!.GET!, mods.observations!.GET!, mods.plans!.GET!]) {
        const r = await m(req("/x", { key: null, headers: spoof }));
        expect(r.status).toBe(503);
        expect(await r.json()).toMatchObject({ error: "not_configured" });
      }
      const withBearer = await mods.profile!.GET!(req("/profile", { key: "anything" }));
      expect(withBearer.status).toBe(503);
      expect((await mods.health!.GET!(new Request(`${BASE}/health`))).status).toBe(200);
    } finally {
      process.env.RUMBO_OWNER_KEY = KEY;
      warn.mockRestore();
    }
  });

  it("serves health without a key", async () => {
    const r = await mods.health!.GET!(new Request(`${BASE}/health`));
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("profile", () => {
  it("is null, then saved, then read back", async () => {
    expect(await (await mods.profile!.GET!(req("/profile"))).json()).toEqual({ profile: null });
    const put = await mods.profile!.PUT!(req("/profile", { method: "PUT", body: json(PROFILE) }));
    expect(put.status).toBe(200);
    const got = await (await mods.profile!.GET!(req("/profile"))).json();
    expect(got.profile).toMatchObject({ home_city: "Valencia", currency: "EUR" });
  });

  it("rejects an invalid profile and bad JSON with the error shape", async () => {
    const bad = await mods.profile!.PUT!(req("/profile", { method: "PUT", body: json({ home_city: "X" }) }));
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error).toBe("invalid_body");
    expect(Array.isArray(body.detail)).toBe(true);
    const notJson = await mods.profile!.PUT!(req("/profile", { method: "PUT", body: "{nope" }));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_json" });
  });
});

describe("watches", () => {
  it("creates with a generated id, lists, replaces by id and deletes", async () => {
    const { id: _id, ...noId } = watch("x");
    const created = await mods.watches!.POST!(req("/watches", { method: "POST", body: json(noId) }));
    expect(created.status).toBe(201);
    const { watch: w } = await created.json();
    expect(w.id).toMatch(/^w_/);

    await mods.watches!.POST!(req("/watches", { method: "POST", body: json({ ...w, label: "renamed" }) }));
    const { watches } = await (await mods.watches!.GET!(req("/watches"))).json();
    expect(watches).toHaveLength(1);
    expect(watches[0].label).toBe("renamed");

    const del = await mods.watch!.DELETE!(req(`/watches/${w.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: w.id }) });
    expect(await del.json()).toEqual({ deleted: w.id });
    const again = await mods.watch!.DELETE!(req(`/watches/${w.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: w.id }) });
    expect(again.status).toBe(404);
  });

  it("rejects a malformed watch", async () => {
    const r = await mods.watches!.POST!(req("/watches", { method: "POST", body: json({ kind: "route", label: "x" }) }));
    expect(r.status).toBe(400);
  });
});

describe("observations", () => {
  it("accepts the valid ones, reports the rejected ones by index", async () => {
    const r = await mods.observations!.POST!(
      req("/observations", { method: "POST", body: json([flight("a"), { kind: "flight", id: "broken" }, flight("c")]) }),
    );
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.accepted).toBe(2);
    expect(out.skipped_older).toBe(0);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].index).toBe(1);
    expect(typeof out.rejected[0].error).toBe("string");
  });

  it("reports an older copy as skipped_older and keeps the newer one", async () => {
    const at = (iso: string, cents: number) =>
      flight("older1", { price: { amount_minor: cents, currency: "EUR" }, provenance: { source: "x", url: "https://example.com/o", seen_at: iso, expires_at: "2099-01-01T00:00:00Z" } });
    await mods.observations!.POST!(req("/observations", { method: "POST", body: json([at("2026-10-22T10:00:00Z", 7000)]) }));
    const r = await mods.observations!.POST!(req("/observations", { method: "POST", body: json([at("2026-10-21T10:00:00Z", 9900)]) }));
    expect(await r.json()).toMatchObject({ accepted: 1, inserted: 0, updated: 0, skipped_older: 1 });
    const { observations } = await (await mods.observations!.GET!(req("/observations?kinds=flight&limit=1000"))).json();
    expect(observations.find((o: { id: string }) => o.id === "older1").price.amount_minor).toBe(7000);
  });

  it("caps a call at 200", async () => {
    const many = Array.from({ length: 201 }, (_, i) => flight(`m${i}`));
    const r = await mods.observations!.POST!(req("/observations", { method: "POST", body: json(many) }));
    expect(r.status).toBe(413);
    const ok = await mods.observations!.POST!(req("/observations", { method: "POST", body: json(many.slice(0, 200)) }));
    expect((await ok.json()).accepted).toBe(200);
  });

  it("lists with filters and validates the query", async () => {
    await mods.observations!.POST!(req("/observations", { method: "POST", body: json({ observations: [flight("z1", { provenance: { source: "x", url: "https://example.com/o", seen_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-02T00:00:00Z" } })] }) }));
    const fresh = await (await mods.observations!.GET!(req("/observations?kinds=flight&limit=1000"))).json();
    expect(fresh.observations.find((o: { id: string }) => o.id === "z1")).toBeUndefined();
    const stale = await (await mods.observations!.GET!(req("/observations?kinds=flight&include_stale=1&limit=1000"))).json();
    expect(stale.observations.find((o: { id: string }) => o.id === "z1")).toBeDefined();
    expect((await mods.observations!.GET!(req("/observations?kinds=boat"))).status).toBe(400);
    expect((await mods.observations!.GET!(req("/observations?since=yesterday"))).status).toBe(400);
  });
});

describe("feedback, history, plans", () => {
  it("records feedback for a known observation only", async () => {
    await mods.observations!.POST!(req("/observations", { method: "POST", body: json([flight("fb1")]) }));
    const ok = await mods.feedback!.POST!(req("/feedback", { method: "POST", body: json({ observation_id: "fb1", action: "saved" }) }));
    expect(ok.status).toBe(201);
    const unknown = await mods.feedback!.POST!(req("/feedback", { method: "POST", body: json({ observation_id: "nope", action: "saved" }) }));
    expect(unknown.status).toBe(404);
    const bad = await mods.feedback!.POST!(req("/feedback", { method: "POST", body: json({ observation_id: "fb1", action: "love" }) }));
    expect(bad.status).toBe(400);
    const { feedback } = await (await mods.feedback!.GET!(req("/feedback?observation_id=fb1"))).json();
    expect(feedback).toHaveLength(1);
  });

  it("adds history from one object or an array", async () => {
    const trip = { id: "t1", title: "Lisbon", from: "2025-05-01", to: "2025-05-04", places: ["Lisbon"] };
    expect((await (await mods.history!.POST!(req("/history", { method: "POST", body: json(trip) }))).json()).accepted).toBe(1);
    expect((await (await mods.history!.POST!(req("/history", { method: "POST", body: json([trip, { ...trip, id: "t2" }]) }))).json()).accepted).toBe(2);
    expect((await (await mods.history!.GET!(req("/history"))).json()).history).toHaveLength(2);
    expect((await mods.history!.POST!(req("/history", { method: "POST", body: json([trip, { id: "bad" }]) }))).status).toBe(400);
  });

  it("lists plans and answers 404 for an unknown one", async () => {
    const { store } = await import("../src/server/store");
    store().putPlan({
      id: "p1", created_at: "2026-10-23T10:00:00Z", status: "choosing",
      request: { window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 3, max: 4 } },
      candidates: [], sections: {}, links: [],
    });
    expect((await (await mods.plans!.GET!(req("/plans"))).json()).plans).toHaveLength(1);
    const got = await mods.plan!.GET!(req("/plans/p1"), { params: Promise.resolve({ id: "p1" }) });
    expect((await got.json()).plan.id).toBe("p1");
    const missing = await mods.plan!.GET!(req("/plans/zz"), { params: Promise.resolve({ id: "zz" }) });
    expect(missing.status).toBe(404);
  });
});
