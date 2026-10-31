// Tenancy and authentication (Teyla Shield, SH7). Synthetic accounts: anonymous, user A, user B.
//
// Rumbo has no Postgres and no row level security. Its tenancy is `createStore(db, userId)`: every query
// filters on `user_id`. The product has one principal today (the owner), so "user B" is a second store on
// the same database, and the tests prove that a store cannot see or change another user's rows on EVERY table.
// A table that is added to the migrations without an entry below fails the suite until it is covered.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../helpers";
import {
  METHODS, NOW, OWNER_KEY, ROOT, WRONG_KEY, bootEnv, dumpAll, dumpUser, loadRoute, observation, planRow, PROFILE_BODY,
  resetLockout, routeFiles, rpc, seedAll, tableInfo, toolCall, tripRow, urlFor, watchRow, MCP_HEADERS, type RouteModule,
} from "./harness";

const tmp = tempDir();
let store: typeof import("../../src/server/store");
let toolsMod: typeof import("../../src/server/mcp/tools");
let serverMod: typeof import("../../src/server/mcp/server");
const MARK = "B-SECRET-MARKER";
/** Text only B's seed (tag "B") writes: descriptive fields, not ids, so an error that echoes a queried id does not match. */
const B_DATA = /(Offer|Watch|Trip|Plan|Note) B\b|City-B/;

beforeAll(async () => {
  bootEnv(tmp.path);
  vi.resetModules();
  store = await import("../../src/server/store");
  toolsMod = await import("../../src/server/mcp/tools");
  serverMod = await import("../../src/server/mcp/server");
  // The owner's own data, so a leak to an anonymous caller has something to show.
  seedAll(store.createStore(store.db(), store.OWNER), MARK);
});
afterAll(() => {
  store.closeDb();
  tmp.cleanup();
});
beforeEach(() => resetLockout());

// --- (a) anonymous callers ------------------------------------------------------------------------------

/** Routes that are public on purpose. A new route that is not here must refuse anonymous callers. */
const PUBLIC_ROUTES = [
  ".well-known/oauth-protected-resource/[[...path]]/route.ts", // OAuth metadata: issuer and resource URLs, no data
  "api/v1/health/route.ts", // liveness: { ok }
  "api/v1/openapi.json/route.ts", // the API description
  "llms.txt/route.ts", // the machine surface description
  "openapi.json/route.ts",
];

let n = 0;
const nextIp = () => `198.51.100.${(n++ % 250) + 1}-${Math.floor(n / 250)}`; // a new client address per call: no lockout in the way

/** Credentials an outsider can present. */
const OUTSIDER: { name: string; headers: Record<string, string> }[] = [
  { name: "no credentials", headers: {} },
  { name: "wrong bearer key", headers: { authorization: `Bearer ${WRONG_KEY}` } },
  { name: "empty bearer", headers: { authorization: "Bearer " } },
  { name: "bare scheme", headers: { authorization: "Bearer" } },
  { name: "basic scheme", headers: { authorization: `Basic ${Buffer.from(`owner:${OWNER_KEY}`).toString("base64")}` } },
  { name: "junk session cookie", headers: { cookie: "rumbo_session=not-a-session" } },
  { name: "the raw key in the session cookie", headers: { cookie: `rumbo_session=${OWNER_KEY}` } },
];

function assertRefusedWithoutLeak(res: Response, text: string, label: string) {
  expect([401, 403], `${label}: status ${res.status}`).toContain(res.status);
  expect(res.headers.get("set-cookie"), label).toBeNull();
  expect(text, label).not.toContain(OWNER_KEY);
  expect(text, label).not.toContain(MARK);
  expect(text, label).not.toMatch(/"result"|"profile"|"watches"|"plans"|"history"|"observations"/);
  expect(() => JSON.parse(text), `${label}: body is JSON`).not.toThrow();
  expect(Object.keys(JSON.parse(text)).sort(), label).toEqual(["detail", "error"]);
}

describe("(a) anonymous callers", () => {
  it("lists every route on disk, and the public ones are exactly the reviewed set", () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThanOrEqual(19);
    for (const p of PUBLIC_ROUTES) expect(files, `${p} no longer exists: remove it from PUBLIC_ROUTES`).toContain(p);
  });

  it("every protected route and method refuses every outsider with 401 and leaks nothing", async () => {
    const before = dumpAll(store.db());
    let calls = 0;
    for (const rel of routeFiles().filter((f) => !PUBLIC_ROUTES.includes(f))) {
      const mod: RouteModule = await loadRoute(rel);
      const methods = METHODS.filter((m) => typeof mod[m] === "function");
      expect(methods.length, `${rel} exports no handler`).toBeGreaterThan(0);
      const { path, params } = urlFor(rel);
      for (const method of methods) {
        for (const who of OUTSIDER) {
          const headers = new Headers({ ...MCP_HEADERS, ...who.headers, "x-forwarded-for": nextIp() });
          const body = method === "GET" || method === "DELETE" ? undefined : method === "POST" && rel.startsWith("mcp") ? rpc("tools/list") : "{}";
          const res = await mod[method]!(new Request(`http://localhost:3000${path}`, { method, headers, body }), { params: Promise.resolve(params) });
          assertRefusedWithoutLeak(res, await res.text(), `${method} ${path} (${who.name})`);
          calls++;
        }
      }
    }
    expect(calls).toBeGreaterThan(150);
    expect(dumpAll(store.db()), "a refused call changed the database").toBe(before);
  });

  it("the public routes say nothing about the owner's data", async () => {
    for (const rel of PUBLIC_ROUTES) {
      const mod = await loadRoute(rel);
      const { path, params } = urlFor(rel);
      const res = await mod.GET!(new Request(`http://localhost:3000${path}`, { headers: { "x-forwarded-for": nextIp() } }), { params: Promise.resolve(params) });
      const text = await res.text();
      expect(text, rel).not.toContain(OWNER_KEY);
      expect(text, rel).not.toContain(MARK);
    }
  });

  it("the key in the /mcp/<key> path: a wrong key, an empty one and a malformed one are refused", async () => {
    const mod = await loadRoute("mcp/[key]/route.ts");
    for (const seg of [WRONG_KEY, "%20", "%E0%A4%A", "..%2F..%2Fapi", "x".repeat(600), encodeURIComponent(OWNER_KEY.toUpperCase())]) {
      for (const method of ["POST", "GET", "DELETE"] as const) {
        const res = await mod[method]!(
          new Request(`http://localhost:3000/mcp/${seg}`, { method, headers: { ...MCP_HEADERS, "x-forwarded-for": nextIp() }, body: method === "POST" ? rpc("tools/list") : undefined }),
          { params: Promise.resolve({ key: seg }) },
        );
        assertRefusedWithoutLeak(res, await res.text(), `${method} /mcp/${seg.slice(0, 20)}`);
      }
    }
  });

  it("every MCP tool refuses an outsider on both entrances and runs nothing", async () => {
    const bearer = await loadRoute("mcp/route.ts");
    const pathed = await loadRoute("mcp/[key]/route.ts");
    const names = toolsMod.TOOLS.map((t) => t.name);
    expect(names).toHaveLength(13);
    const before = dumpAll(store.db());
    const handlers = toolsMod.TOOLS.map((t) => vi.spyOn(t, "handler"));
    for (const name of names) {
      const body = toolCall(name, {});
      for (const who of OUTSIDER) {
        const res = await bearer.POST!(new Request("http://localhost:3000/mcp", { method: "POST", headers: { ...MCP_HEADERS, ...who.headers, "x-forwarded-for": nextIp() }, body }));
        assertRefusedWithoutLeak(res, await res.text(), `${name} via /mcp (${who.name})`);
      }
      const res = await pathed.POST!(
        new Request(`http://localhost:3000/mcp/${WRONG_KEY}`, { method: "POST", headers: { ...MCP_HEADERS, "x-forwarded-for": nextIp() }, body }),
        { params: Promise.resolve({ key: WRONG_KEY }) },
      );
      assertRefusedWithoutLeak(res, await res.text(), `${name} via /mcp/<wrong key>`);
    }
    for (const h of handlers) expect(h).not.toHaveBeenCalled();
    expect(dumpAll(store.db())).toBe(before);
    vi.restoreAllMocks();
  });

  it("the page proxy sends an outsider to /signin and shows nothing", async () => {
    const { proxy } = await import("../../proxy");
    const { NextRequest } = await import("next/server");
    for (const who of OUTSIDER) {
      const res = proxy(new NextRequest("http://localhost:3000/profile", { headers: who.headers }));
      expect(res?.status, who.name).toBeGreaterThanOrEqual(300);
      expect(res?.status, who.name).toBeLessThan(400);
      expect(res?.headers.get("location"), who.name).toContain("/signin");
    }
    const signedIn = proxy(new NextRequest("http://localhost:3000/profile", { headers: { authorization: `Bearer ${OWNER_KEY}` } }));
    expect(signedIn, "the owner passes").toBeUndefined();
  });

  it("every server action asserts the owner before anything else", () => {
    const actions: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "actions.ts" && !p.includes(`${join("app", "signin")}`)) actions.push(p);
      }
    };
    walk(join(ROOT, "app"));
    expect(actions.length).toBeGreaterThanOrEqual(5);
    let functions = 0;
    for (const file of actions) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
        functions++;
        expect(m[2]!, `${file} ${m[1]} must call assertOwner() first`).toMatch(/^\s*(try \{\s*)?await assertOwner\(\)/);
      }
    }
    expect(functions).toBeGreaterThanOrEqual(9);
  });
});

// --- (b) tenancy in the store -----------------------------------------------------------------------------

/** Tables with a `user_id` column: every one needs a seed (how B writes to it) and is attacked below. */
const TENANT_TABLES = ["feedback", "history", "observations", "plans", "profile", "watches"];
/** Tables with no user data: counters and run records. Adding a column called user_id here would move it above. */
const GLOBAL_TABLES: Record<string, string> = {
  runs: "collector run records: source name, times, call count and an error string. No user content.",
  source_calls: "a daily call counter per provider, for the spend caps.",
};

describe("(b) a store cannot read or change another user's rows", () => {
  it("every table in the migrations is classified, and tenant tables carry user_id", () => {
    const db = store.openDb(":memory:");
    const found = tableInfo(db);
    for (const t of found) {
      if (t.tenant) expect(TENANT_TABLES, `table ${t.name} has user_id but no tenancy test: add it to TENANT_TABLES and attack it below`).toContain(t.name);
      else expect(Object.keys(GLOBAL_TABLES), `table ${t.name} is new and has no user_id column: classify it in GLOBAL_TABLES with a reason, or add user_id`).toContain(t.name);
    }
    expect(found.filter((t) => t.tenant).map((t) => t.name).sort()).toEqual([...TENANT_TABLES].sort());
    expect(store.MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("every SQL statement on a tenant table in store.ts names user_id", () => {
    const text = readFileSync(join(ROOT, "src", "server", "store.ts"), "utf8");
    // Template literals and strings that hold SQL, outside the migration block.
    const afterMigrations = text.slice(text.indexOf("export function dbPath"));
    const statements = [...afterMigrations.matchAll(/(["`])((?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?)\1/g)].map((m) => m[2]!);
    expect(statements.length).toBeGreaterThan(20);
    let checked = 0;
    let dynamic = 0;
    for (const sql of statements) {
      const touches = TENANT_TABLES.some((t) => new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${t}\\b`, "i").test(sql));
      if (!touches) continue;
      checked++;
      // A WHERE built from an array starts from ["user_id = ?"]; the count of those arrays is checked below.
      if (/\$\{where\.join/.test(sql)) dynamic++;
      else expect(sql, "tenant-table statement without user_id").toMatch(/user_id/);
    }
    expect(checked).toBeGreaterThan(15);
    expect(dynamic).toBeGreaterThan(0);
    expect(afterMigrations.split('const where = ["user_id = ?"];').length - 1, "every dynamic WHERE starts from user_id").toBe(dynamic);
  });

  it("A cannot read, list, update or delete B's rows on any tenant table", () => {
    const db = store.openDb(":memory:");
    const A = store.createStore(db, "user-a");
    const B = store.createStore(db, "user-b");
    const b = seedAll(B, "B");
    const a = seedAll(A, "A");
    const before = dumpUser(db, "user-b");
    for (const t of TENANT_TABLES) expect(JSON.parse(before)[t].length, `B has a row in ${t}`).toBeGreaterThan(0);

    // read and list: A sees A's rows only
    expect(A.getProfile()?.home_city).toBe("City-A");
    expect(JSON.stringify([A.listWatches(), A.listHistory(), A.listPlans(), A.listFeedback(), A.listObservations({ includeStale: true })])).not.toMatch(B_DATA);
    expect(A.getWatch(b.watch)).toBeNull();
    expect(A.getObservation(b.obs)).toBeNull();
    expect(A.getPlan(b.plan)).toBeNull();
    expect(A.listFeedback({ observationId: b.obs })).toEqual([]);
    expect(A.usage(NOW)).toMatchObject({ observations: 1, plans: 1 });

    // update B's rows by their ids: A gets its own row or nothing, B's stay as they were
    expect(A.markWatchRun(b.watch, "2026-10-31T10:00:00.000Z"), "stamping B's watch id as A").toBe(false);
    A.upsertWatch(watchRow(b.watch, "HIJACK"));
    A.upsertObservations([{ ...(observation(b.obs, "HIJACK") as object), provenance: { source: "x", seen_at: "2026-10-31T09:30:00+01:00" } }]);
    A.upsertHistory([tripRow(b.trip, "HIJACK")]);
    A.putPlan(planRow(b.plan, "HIJACK"), NOW);
    A.putProfile(PROFILE_BODY("HIJACK"), NOW);
    expect(A.putPlanUnlessArchived(planRow("plan-unknown-to-a", "x"), NOW)).toBeNull();
    expect(A.replaceHistorySource("synthetic-source", [tripRow(b.trip, "HIJACK again")])).toMatchObject({ count: 1 }); // no "conflict" with B's id
    expect(A.replaceHistorySource("synthetic-source", [])).toMatchObject({ count: 0 });
    A.replaceBusySource("Other", [{ from: "2026-11-01", to: "2026-11-02", what: "Trip" }], NOW);
    A.addFeedback({ observation_id: b.obs, action: "dismissed" }, NOW); // the store takes any id; the handler checks (below)

    // delete: A's delete by B's id removes nothing of B's
    expect(A.deleteWatch("w-B")).toBe(true); // A's own HIJACK copy of that id
    expect(A.getWatch("w-B")).toBeNull();
    expect(A.deleteWatch("w-does-not-exist")).toBe(false);

    expect(dumpUser(db, "user-b"), "B's rows changed").toBe(before);
    expect(B.listWatches().map((w) => w.label)).toEqual(["Watch B"]);
    expect(B.getProfile()?.home_city).toBe("City-B");
    expect(a.watch).toBe("w-A");
    db.close();
  });

  it("the same holds for B acting on A's rows (the check is symmetric)", () => {
    const db = store.openDb(":memory:");
    const A = store.createStore(db, "user-a");
    const B = store.createStore(db, "user-b");
    seedAll(A, "A");
    const before = dumpUser(db, "user-a");
    B.deleteWatch("w-A");
    B.upsertHistory([tripRow("trip-A", "HIJACK")]);
    B.replaceHistorySource("synthetic-source", []);
    expect(dumpUser(db, "user-a")).toBe(before);
    db.close();
  });
});

describe("(b) the MCP tools answer from the caller's store only", () => {
  it("as A, no tool returns B's data, and writes that name B's ids fail or stay in A", async () => {
    const db = store.openDb(":memory:");
    const A = store.createStore(db, "user-a");
    const B = store.createStore(db, "user-b");
    const b = seedAll(B, "B");
    const before = dumpUser(db, "user-b");
    const tool = (name: string) => toolsMod.TOOLS.find((t) => t.name === name)!;
    const run = async (name: string, args: unknown) => {
      const r = await serverMod.runTool(tool(name), args, { store: A, now: NOW });
      return { isError: r.isError === true, text: r.content[0]!.text };
    };

    const reads = [
      ["rumbo_feed", { limit: 50 }], ["rumbo_profile_get", {}], ["rumbo_watch_list", {}], ["rumbo_plan_get", {}],
      ["rumbo_plan_get", { plan_id: b.plan }], ["rumbo_to_loco", { plan_id: b.plan }], ["rumbo_agent_brief", { agent: "synthetic-agent" }],
    ] as const;
    for (const [name, args] of reads) {
      const out = await run(name, args);
      expect(out.text, `${name} ${JSON.stringify(args)}`).not.toMatch(B_DATA);
    }
    expect((await run("rumbo_plan_get", { plan_id: b.plan })).text).toContain("not_found");
    expect((await run("rumbo_to_loco", { plan_id: b.plan })).text).toContain("not_found");

    // writes aimed at B's ids
    expect((await run("rumbo_watch_add", { ...watchRow(b.watch, "HIJACK"), agent: "synthetic-agent" })).text).toContain("not_found");
    expect((await run("rumbo_feedback", { observation_id: b.obs, action: "dismissed" })).text).toContain("unknown_observation");
    expect((await run("rumbo_plan_choose", { plan_id: b.plan, place: "Lisbon" })).isError).toBe(true);
    await run("rumbo_import_history", { trips: [tripRow(b.trip, "HIJACK")] });
    await run("rumbo_profile_update", { set: { home_city: "HIJACK", home_airports: ["VLC"] }, note: "hijack note" });

    expect(dumpUser(db, "user-b"), "a tool changed B's rows").toBe(before);
    db.close();
  });

  it("the HTTP layer has one principal: the store never follows the credential", async () => {
    // authorize() names the principal by a fingerprint of the key. store() ignores it and is always OWNER.
    // When a second user is added, extend this suite with a request-level A/B case before shipping.
    expect(store.OWNER).toBe("owner");
    expect(store.store().userId).toBe("owner");
  });
});

// --- (c) the lockout --------------------------------------------------------------------------------------

describe("(c) the lockout", () => {
  const FAILS = 10; // perKey in src/server/ratelimit.ts authLockout()
  const ip = "203.0.113.77";
  const withIp = (extra: Record<string, string>, address = ip) => ({ ...MCP_HEADERS, "x-forwarded-for": address, ...extra });

  it("ten wrong keys from one address, then the right key from it is 429; another address still works", async () => {
    const profile = await loadRoute("api/v1/profile/route.ts");
    const get = (headers: Record<string, string>) => profile.GET!(new Request("http://localhost:3000/api/v1/profile", { headers }));
    for (let i = 0; i < FAILS; i++) expect((await get(withIp({ authorization: `Bearer ${WRONG_KEY}-${i}` }))).status).toBe(401);
    const locked = await get(withIp({ authorization: `Bearer ${OWNER_KEY}` }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("600");
    expect(await locked.text()).not.toContain(MARK);
    expect((await get(withIp({ authorization: `Bearer ${OWNER_KEY}` }, "203.0.113.78"))).status, "a different client is not locked").toBe(200);
  });

  it("the same counter covers /mcp, /mcp/<key> and sign-in", async () => {
    const bearer = await loadRoute("mcp/route.ts");
    const pathed = await loadRoute("mcp/[key]/route.ts");
    const post = (headers: Record<string, string>) => bearer.POST!(new Request("http://localhost:3000/mcp", { method: "POST", headers, body: rpc("tools/list") }));
    for (let i = 0; i < FAILS; i++) await post(withIp({ authorization: `Bearer ${WRONG_KEY}-${i}` }));
    expect((await post(withIp({ authorization: `Bearer ${OWNER_KEY}` }))).status).toBe(429);
    const viaPath = await pathed.POST!(
      new Request(`http://localhost:3000/mcp/${OWNER_KEY}`, { method: "POST", headers: withIp({}), body: rpc("tools/list") }),
      { params: Promise.resolve({ key: OWNER_KEY }) },
    );
    expect(viaPath.status, "the right key in the path from a locked address").toBe(429);
    const auth = await import("../../src/server/auth");
    expect(auth.signInLocked(ip), "sign-in shares the lockout").toBe(true);
    expect(auth.signInLocked("203.0.113.99")).toBe(false);
  });

  it("wrong keys in the URL path count like wrong bearers", async () => {
    const pathed = await loadRoute("mcp/[key]/route.ts");
    const address = "203.0.113.120";
    for (let i = 0; i < FAILS; i++) {
      const k = `${WRONG_KEY}-${i}`;
      const res = await pathed.POST!(new Request(`http://localhost:3000/mcp/${k}`, { method: "POST", headers: withIp({}, address), body: rpc("tools/list") }), { params: Promise.resolve({ key: k }) });
      expect(res.status).toBe(401);
    }
    const bearer = await loadRoute("mcp/route.ts");
    const res = await bearer.POST!(new Request("http://localhost:3000/mcp", { method: "POST", headers: withIp({ authorization: `Bearer ${OWNER_KEY}` }, address), body: rpc("tools/list") }));
    expect(res.status, "the right bearer after ten wrong path keys").toBe(429);
  });

  it("a stale session cookie is not a guess and never locks the owner out", async () => {
    const profile = await loadRoute("api/v1/profile/route.ts");
    for (let i = 0; i < FAILS + 3; i++) {
      const res = await profile.GET!(new Request("http://localhost:3000/api/v1/profile", { headers: withIp({ cookie: "rumbo_session=stale" }, "203.0.113.200") }));
      expect(res.status).toBe(401);
    }
    const ok = await profile.GET!(new Request("http://localhost:3000/api/v1/profile", { headers: withIp({ authorization: `Bearer ${OWNER_KEY}` }, "203.0.113.200") }));
    expect(ok.status).toBe(200);
  });
});
