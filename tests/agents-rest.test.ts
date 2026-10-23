import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLlmsTxt } from "../src/server/llms";
import { buildOpenApi } from "../src/server/openapi";
import { siteUrl } from "../src/server/site";
import { PROFILE, flight, tempDir } from "./helpers";

const KEY = "rest-owner-key-0123456789";
const tmp = tempDir();
const BASE = "http://localhost:3000";

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;
const mods: Record<string, Record<string, Handler>> = {};
let closeDb: () => void;

function req(path: string, init: RequestInit & { key?: string | null } = {}): Request {
  const { key = KEY, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { ...rest, headers });
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const live = (id: string, over: Record<string, unknown> = {}) =>
  flight(id, { provenance: { source: "kiwi-mcp", url: "https://example.com/o", seen_at: hours(-2), expires_at: hours(40) }, depart_date: "2026-12-06", return_date: "2026-12-09", ...over });

beforeAll(async () => {
  process.env.RUMBO_DB = tmp.path;
  process.env.RUMBO_OWNER_KEY = KEY;
  vi.resetModules();
  mods.feed = (await import("../app/api/v1/feed/route")) as unknown as Record<string, Handler>;
  mods.brief = (await import("../app/api/v1/brief/route")) as unknown as Record<string, Handler>;
  mods.profile = (await import("../app/api/v1/profile/route")) as unknown as Record<string, Handler>;
  mods.observations = (await import("../app/api/v1/observations/route")) as unknown as Record<string, Handler>;
  mods.loco = (await import("../app/api/v1/plans/[id]/loco/route")) as unknown as Record<string, Handler>;
  mods.openapi = (await import("../app/api/v1/openapi.json/route")) as unknown as Record<string, Handler>;
  mods.openapiAlias = (await import("../app/openapi.json/route")) as unknown as Record<string, Handler>;
  mods.llms = (await import("../app/llms.txt/route")) as unknown as Record<string, Handler>;
  closeDb = (await import("../src/server/store")).closeDb;
});
afterAll(() => {
  closeDb();
  tmp.cleanup();
});
beforeEach(async () => {
  const { store } = await import("../src/server/store");
  store().putProfile(PROFILE);
});

describe("GET /api/v1/feed", () => {
  it("needs the key, ranks best first, and rejects unknown kinds", async () => {
    expect((await mods.feed!.GET!(req("/api/v1/feed", { key: null }))).status).toBe(401);

    const { store } = await import("../src/server/store");
    store().upsertObservations([
      live("cheap", { price: { amount_minor: 4900, currency: "EUR" } }),
      live("dear", { price: { amount_minor: 41000, currency: "EUR" }, destination: "JFK", place: "New York" }),
    ]);
    const res = await mods.feed!.GET!(req("/api/v1/feed?limit=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; score: number }[] };
    expect(body.items.length).toBeGreaterThan(0);
    const scores = body.items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const bad = await mods.feed!.GET!(req("/api/v1/feed?kinds=train"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_query" });
  });
});

describe("GET /api/v1/brief", () => {
  it("requires an agent name and returns the brief for it", async () => {
    const none = await mods.brief!.GET!(req("/api/v1/brief"));
    expect(none.status).toBe(400);
    const ok = await mods.brief!.GET!(req("/api/v1/brief?agent=grok-task&connectors=Viator,web%20search"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { agent: string; rules: string[]; report: { examples: unknown } };
    expect(body.agent).toBe("grok-task");
    expect(body.rules.join(" ")).toMatch(/never scrape/i);
    expect(body.report.examples).toBeTruthy();
  });
});

describe("PATCH /api/v1/profile", () => {
  it("merges without deleting and records the note with the agent", async () => {
    const res = await mods.profile!.PATCH!(
      req("/api/v1/profile", { method: "PATCH", body: JSON.stringify({ set: { interests: { coffee: 2 } }, note: "Likes slow mornings", agent: "codex-automation" }) }),
    );
    expect(res.status).toBe(200);
    const { store } = await import("../src/server/store");
    const p = store().getProfile()!;
    expect(p.interests).toMatchObject({ food: 2, coffee: 2 });
    expect(p.home_city).toBe("Valencia");
    expect(p.notes.at(-1)).toMatchObject({ text: "Likes slow mornings", provenance: { source: "agent", agent: "codex-automation" } });

    const bad = await mods.profile!.PATCH!(req("/api/v1/profile", { method: "PATCH", body: JSON.stringify({ set: { notes: [] } }) }));
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/v1/observations", () => {
  it("accepts rows without an id, stamps the agent and rejects a price with no page", async () => {
    const { id: _id, ...noId } = live("x") as unknown as Record<string, unknown> & { id: string };
    const noUrl = { ...noId, title: "No page", provenance: { source: "web", seen_at: hours(-1) } };
    const res = await mods.observations!.POST!(
      req("/api/v1/observations", { method: "POST", body: JSON.stringify({ agent: "grok-task", observations: [noId, noUrl] }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; rejected: { index: number; error: string }[] };
    expect(body.accepted).toBe(1);
    expect(body.rejected.map((r) => r.index)).toEqual([1]);
    const { store } = await import("../src/server/store");
    const stored = store().listStoredObservations({ limit: 10, includeStale: true });
    expect(stored.some((r) => r.observation.provenance.agent === "grok-task")).toBe(true);
  });
});

describe("GET /api/v1/plans/[id]/loco", () => {
  it("returns the loco_propose arguments, 404 for an unknown plan", async () => {
    const { store } = await import("../src/server/store");
    const s = store();
    s.upsertObservations([live("pf")]);
    s.putPlan({
      id: "plan-rest", created_at: hours(-1), status: "ready",
      request: { window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 3, max: 3 }, interests: [], needs: ["flights"] },
      candidates: [{ place: "Lisbon", country: "Portugal", airports: ["LIS"], score: 0.8, reasons: ["x"] }],
      chosen: "Lisbon", dates: { from: "2026-12-06", to: "2026-12-09" },
      sections: { flights: ["pf"], stay: [], car: [], activities: [], events: [] }, links: [],
    });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const ok = await mods.loco!.GET!(req("/api/v1/plans/plan-rest/loco?trip_slug=lisbon-dec"), ctx("plan-rest"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { loco_propose_args: { slug: string } }).loco_propose_args.slug).toBe("lisbon-dec");
    expect((await mods.loco!.GET!(req("/api/v1/plans/none/loco"), ctx("none"))).status).toBe(404);
    expect(s.getPlan("plan-rest")!.status).toBe("ready");
  });
});

describe("openapi.json", () => {
  it("is OpenAPI 3.1 with unique operation ids, short descriptions, bearer auth and no delete or booking", () => {
    const doc = buildOpenApi("https://rumbo.example") as {
      openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { operationId: string; description?: string; summary?: string }>>;
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
    };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.servers[0]!.url).toBe("https://rumbo.example");
    expect(doc.components.securitySchemes.ownerKey).toMatchObject({ type: "http", scheme: "bearer" });
    const ids: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        ids.push(op.operationId);
        expect(method).not.toBe("delete");
        expect(op.description?.length ?? 0).toBeLessThanOrEqual(300);
        expect(path).not.toMatch(/book|pay|checkout/i);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["getFeed", "getAgentBrief", "postObservations", "getPlanAsLocoProposal"]));
  });

  it("is served publicly at both paths, contains no key, and follows the request host", async () => {
    for (const mod of [mods.openapi!, mods.openapiAlias!]) {
      const res = await mod.GET!(new Request(`${BASE}/openapi.json`, { headers: { host: "rumbo.example", "x-forwarded-proto": "https" } }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text).servers[0].url).toBe("https://rumbo.example");
    }
  });
});

describe("llms.txt", () => {
  it("is plain text, names the tools and endpoints, and carries no secret", async () => {
    const res = await mods.llms!.GET!(new Request(`${BASE}/llms.txt`, { headers: { host: "rumbo.example", "x-forwarded-proto": "https" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    for (const name of ["rumbo_agent_brief", "rumbo_observe", "rumbo_feed", "https://rumbo.example/mcp"]) expect(text).toContain(name);
    expect(buildLlmsTxt("https://x.example")).toContain("https://x.example/");
  });
});

describe("siteUrl", () => {
  it("prefers RUMBO_PUBLIC_URL, then the forwarded host, then localhost, and refuses odd hosts", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(siteUrl(h({ host: "a.example" }), { RUMBO_PUBLIC_URL: "https://fixed.example/" } as unknown as NodeJS.ProcessEnv)).toBe("https://fixed.example");
    expect(siteUrl(h({ host: "internal:3110", "x-forwarded-host": "rumbo.example", "x-forwarded-proto": "https" }), {} as NodeJS.ProcessEnv)).toBe("https://rumbo.example");
    expect(siteUrl(h({ host: "localhost:3000" }), {} as NodeJS.ProcessEnv)).toBe("http://localhost:3000");
    expect(siteUrl(h({ host: "evil.example/x y" }), {} as NodeJS.ProcessEnv)).toBe("http://localhost:3000");
    expect(siteUrl(undefined, {} as NodeJS.ProcessEnv)).toBe("http://localhost:3000");
  });
});
