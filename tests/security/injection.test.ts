// The injection corpus against Rumbo's real MCP handlers (Teyla Shield, SH7 / section 5.5).
//
// Source of the corpus: injection_cases.json in this folder, a copy of templates/security/injection_cases.json
// in the teyla repo (version 1, 43 invented cases). Structure follows templates/security/tests/vitest/security.test.ts.
//
// Every call goes through app/mcp/route.ts (auth, lockout, body cap, the SDK transport, schema validation, the
// handler). No model is in the loop. The suite asserts EFFECTS: which handlers ran, which hosts were contacted,
// which rows changed, who is named as the author. It does not assert that a payload "looks" harmless.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../helpers";
import {
  MCP_HEADERS, NOW, OWNER_KEY, ROOT, bootEnv, canaryForms, captureFetch, documentedHosts, dumpUser, idea, observation, planRow,
  resetLockout, rpc, seedAll, stripInvisible, toolCall, tripRow, watchRow, type Seen,
} from "./harness";

type Case = { id: string; family: string; input: string; expect: string; repeat?: number; canary?: string };
const corpus: { version: number; cases: Case[] } = JSON.parse(readFileSync(join(ROOT, "tests", "security", "injection_cases.json"), "utf8"));
const family = (f: string) => corpus.cases.filter((c) => c.family === f);
const valueOf = (c: Case) => (c.repeat ? c.input.repeat(c.repeat) : c.input);

const tmp = tempDir();
type Mcp = { POST: (req: Request) => Promise<Response> };
let mcp: Mcp;
let store: typeof import("../../src/server/store");
let toolsMod: typeof import("../../src/server/mcp/tools");
let capture: ReturnType<typeof captureFetch>;
let seen: Seen[];
let ipCounter = 0;
const AGENT = "synthetic-agent";
const SEED = { obs: "obs-seed", plan: "plan-seed", watch: "w-seed" };

const synthetic = { TRAVELPAYOUTS_TOKEN: "synthetic-tp-token", VIATOR_API_KEY: "synthetic-viator-key", TIQETS_API_KEY: "synthetic-tiqets-key" };

beforeAll(async () => {
  bootEnv(tmp.path, synthetic);
  vi.resetModules();
  store = await import("../../src/server/store");
  toolsMod = await import("../../src/server/mcp/tools");
  mcp = (await import("../../app/mcp/route")) as unknown as Mcp;
});
afterAll(() => {
  store.closeDb();
  tmp.cleanup();
});

/** Fresh state per test: the owner's seed rows, and user B's rows next to them (B must never change). */
function reseed() {
  const db = store.db();
  for (const t of ["profile", "history", "watches", "observations", "feedback", "plans", "runs", "source_calls"]) db.exec(`DELETE FROM ${t}`);
  const owner = store.createStore(db, store.OWNER);
  owner.putProfile({ home_city: "Testville", home_airports: ["VLC"], interests: { food: 2 } }, NOW);
  owner.upsertObservations([observation(SEED.obs, "Seed offer")]);
  owner.upsertWatch(watchRow(SEED.watch, "Seed watch"));
  owner.putPlan(planRow(SEED.plan, "Seed plan"), NOW);
  owner.upsertHistory([tripRow("trip-seed", "Seed trip")]);
  seedAll(store.createStore(db, "user-b"), "B");
}

beforeEach(() => {
  resetLockout();
  reseed();
  capture = captureFetch();
  seen = capture.seen;
});
afterEach(() => {
  capture.restore();
  vi.restoreAllMocks();
});

// --- calling ---------------------------------------------------------------------------------------------------

interface Answer { status: number; rpcError?: { code: number; message: string }; isError: boolean; text: string; json: Record<string, unknown> | null }

async function post(body: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return mcp.POST(new Request("http://localhost:3000/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${OWNER_KEY}`, "x-forwarded-for": `198.51.100.${(ipCounter++ % 250) + 1}-${Math.floor(ipCounter / 250)}`, ...extraHeaders },
    body,
  }));
}

async function call(name: string, args: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await post(toolCall(name, args), headers);
  const raw = await res.text();
  let body: { result?: { isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } } = {};
  try { body = JSON.parse(raw); } catch { /* not JSON: the assertions below say so */ }
  const text = body.result?.content?.[0]?.text ?? raw;
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, rpcError: body.error, isError: body.result?.isError === true, text, json };
}

/** Valid arguments for every tool. Every string in them is attacked, one at a time. */
const BASE: Record<string, unknown> = {
  rumbo_feed: { limit: 5, kinds: ["flight"] },
  rumbo_feedback: { observation_id: SEED.obs, action: "saved", note: "a note" },
  rumbo_profile_get: {},
  rumbo_profile_update: { set: { home_city: "Testville", home_airports: ["VLC"], wishlist: ["Lisbon"] }, note: "prefers aisle seats", agent: AGENT },
  rumbo_watch_list: {},
  rumbo_watch_add: { kind: "place-events", label: "Events in Lisbon", place: "Lisbon", window: { from: "2026-12-01", to: "2026-12-31" }, agent: AGENT },
  rumbo_observe: { agent: AGENT, observations: [idea("A synthetic idea")], checked_watch_ids: [SEED.watch] },
  rumbo_import_history: { trips: [tripRow("trip-new", "A past trip")] },
  rumbo_agent_brief: { agent: AGENT, connectors: ["web search"] },
  rumbo_plan_start: { text: "four days in Lisbon in December" },
  rumbo_plan_get: { plan_id: SEED.plan },
  rumbo_plan_choose: { plan_id: SEED.plan, place: "Lisbon" },
  rumbo_to_loco: { plan_id: SEED.plan, trip_slug: "synthetic-trip" },
};
/** Tools that call outside services by design (hints.openWorld). All others must make no request at all. */
const OPEN_WORLD = new Set(["rumbo_plan_start", "rumbo_plan_choose"]);
/** Tools that write what the agent sends, so a new row may appear. */
const WRITERS = new Set(["rumbo_profile_update", "rumbo_watch_add", "rumbo_observe", "rumbo_import_history", "rumbo_feedback", "rumbo_plan_start", "rumbo_plan_choose"]);

type Path = (string | number)[];
function leaves(v: unknown, path: Path = []): Path[] {
  if (typeof v === "string") return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [];
}
function withValue(base: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(base) as Record<string | number, unknown>;
  let cur = copy;
  path.slice(0, -1).forEach((k) => (cur = cur[k] as Record<string | number, unknown>));
  cur[path[path.length - 1]!] = value;
  return copy;
}

const watchSummary = () => JSON.stringify(store.createStore(store.db()).listWatches().map((w) => [w.id, w.created_by, w.active]).sort());
const noteAgents = () => JSON.stringify((store.createStore(store.db()).getProfile()?.notes ?? []).map((n) => n.provenance.agent));
const authorOf = () => {
  const s = store.createStore(store.db());
  return [...s.listWatches().map((w) => w.created_by), ...(s.getProfile()?.notes ?? []).map((n) => n.provenance.agent ?? "")];
};

const spies = () => toolsMod.TOOLS.map((t) => ({ name: t.name, spy: vi.spyOn(t, "handler") }));

// --- the suite ---------------------------------------------------------------------------------------------------

describe("the corpus and the tool list", () => {
  it("the corpus has every family", () => {
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);
    for (const f of ["forged-instruction", "delimiter-escape", "encoded-canary", "attacker-url", "oversize", "permission-change", "log-to-leak", "rug-pull"]) {
      expect(family(f).length, f).toBeGreaterThan(0);
    }
  });

  it("every tool has a valid base call here, and the open-world set matches the tools' own hints", async () => {
    const names = toolsMod.TOOLS.map((t) => t.name).sort();
    expect(Object.keys(BASE).sort(), "a new tool must be added to BASE so the corpus runs against it").toEqual(names);
    for (const [name, args] of Object.entries(BASE)) {
      const a = await call(name, args);
      expect(a.status, name).toBe(200);
      expect(a.rpcError, name).toBeUndefined();
      // plan tools may report a source problem as data, but the base call itself must be valid input
      expect(a.json?.error, `${name} base call: ${a.text.slice(0, 200)}`).not.toBe("invalid_input");
    }
    for (const t of toolsMod.TOOLS) expect(t.hints.openWorld, t.name).toBe(OPEN_WORLD.has(t.name));
  });

  it("tool descriptions are identical across two sessions (no rug-pull inside the server)", async () => {
    const list = async () => JSON.stringify(((await (await post(rpc("tools/list"))).json()) as { result: { tools: unknown[] } }).result.tools);
    expect(await list()).toBe(await list());
  });
});

describe("forged instructions, delimiter escapes, permission changes and log-to-leak texts", () => {
  const attacks = [...family("forged-instruction"), ...family("delimiter-escape"), ...family("permission-change"), ...family("log-to-leak")];

  it("in every string argument of every tool: one handler at most, only documented hosts, no foreign rows, no new author", async () => {
    const allowedHosts = documentedHosts();
    expect(allowedHosts).toContain("mcp.kiwi.com");
    let calls = 0;
    for (const [name, base] of Object.entries(BASE)) {
      for (const path of leaves(base)) {
        for (const c of attacks) {
          resetLockout(); // 500+ calls from one key would otherwise meet the 600-per-minute limit
          const bBefore = dumpUser(store.db(), "user-b");
          const watchesBefore = watchSummary();
          const authorsBefore = authorOf();
          seen.length = 0;
          const handlers = spies();
          const a = await call(name, withValue(base, path, c.input));
          const label = `${name} ${path.join(".")} <- ${c.id}`;
          calls++;

          expect(a.status, `${label}: HTTP`).toBe(200);
          expect(a.rpcError, `${label}: JSON-RPC error`).toBeUndefined();
          expect(a.json, `${label}: the answer is JSON data, the payload did not break out of it`).not.toBeNull();
          if (a.isError) expect(a.json!.error, `${label}: refused, never an internal error: ${a.text.slice(0, 300)}`).not.toBe("internal");

          // no other tool was called: at most the one that was asked for
          const ran = handlers.filter((h) => h.spy.mock.calls.length > 0);
          expect(ran.map((h) => h.name), label).toEqual(ran.length ? [name] : []);
          expect(ran.reduce((n, h) => n + h.spy.mock.calls.length, 0), label).toBeLessThanOrEqual(1);
          handlers.forEach((h) => h.spy.mockRestore());

          // no request outside the documented hosts, and none at all from a tool that does not call out
          for (const s of seen) expect(allowedHosts, `${label}: undocumented host ${s.host}`).toContain(s.host);
          if (!OPEN_WORLD.has(name)) expect(seen, `${label}: ${name} made a request`).toHaveLength(0);

          // no row of another user changed; nothing was attributed to the owner
          expect(dumpUser(store.db(), "user-b"), `${label}: user B's rows changed`).toBe(bBefore);
          const added = authorOf().filter((x, i, all) => all.indexOf(x) === i && !authorsBefore.includes(x));
          for (const who of added) expect(who, `${label}: new author`).toBe(AGENT);
          if (!WRITERS.has(name)) expect(watchSummary(), `${label}: watches changed`).toBe(watchesBefore);
          expect(authorOf().filter((x) => x.trim().toLowerCase() === "owner" && !authorsBefore.includes(x)), label).toEqual([]);

          // keep the 100-watch cap out of the way
          const s = store.createStore(store.db());
          for (const w of s.listWatches()) if (w.id !== SEED.watch) s.deleteWatch(w.id);
        }
      }
    }
    expect(calls).toBeGreaterThan(500);
  }, 280_000);

  it("an agent cannot sign as the owner, by argument or by header", async () => {
    const ownersBefore = authorOf().filter((x) => x.trim().toLowerCase() === "owner").length; // the seed rows are the owner's
    for (const who of ["owner", "Owner", " OWNER ", "owner\t"]) {
      for (const name of ["rumbo_profile_update", "rumbo_watch_add", "rumbo_observe", "rumbo_agent_brief"]) {
        const args = withValue(BASE[name], ["agent"], who);
        const a = await call(name, name === "rumbo_observe" || name === "rumbo_agent_brief" ? args : args);
        expect(a.json?.error, `${name} as ${JSON.stringify(who)}: ${a.text.slice(0, 120)}`).toMatch(/reserved_agent|invalid_input/);
      }
    }
    // A header cannot name the owner either: cleanAgent drops it and the call is signed with the neutral label.
    const a = await call("rumbo_profile_update", { note: "header impersonation" }, { "x-rumbo-agent": "owner" });
    expect(a.isError, a.text.slice(0, 120)).toBe(false);
    const b = await call("rumbo_profile_update", { note: " query impersonation" }, { "x-rumbo-agent": " Owner" });
    expect(b.isError, b.text.slice(0, 120)).toBe(false);
    expect(authorOf().filter((x) => x.trim().toLowerCase() === "owner").length).toBe(ownersBefore);
  });
});

describe("attacker URLs", () => {
  const urls = family("attacker-url");

  it("no tool fetches a URL an agent supplies, and a stored link is http(s) only", async () => {
    const allowedHosts = documentedHosts();
    for (const c of urls) {
      const attackerHost = (() => { try { return new URL(c.input).hostname.replace(/^\[|\]$/g, ""); } catch { return ""; } })();
      for (const field of ["url", "book_url"] as const) {
        seen.length = 0;
        const row = field === "url"
          ? idea(`link ${c.id}`, { provenance: { source: "synthetic-agent", url: c.input, seen_at: "2026-10-31T09:00:00+01:00" } })
          : idea(`book ${c.id}`, { book_url: c.input });
        const a = await call("rumbo_observe", { agent: AGENT, observations: [row] });
        expect(a.status, `${c.id} ${field}`).toBe(200);
        expect(a.json!.error ?? "", `${c.id} ${field}`).not.toBe("internal");
        expect(seen, `${c.id} ${field}: observe fetched something`).toHaveLength(0);
        const stored = store.createStore(store.db()).listObservations({ includeStale: true }).find((o) => o.title === row.title);
        const url = field === "url" ? stored?.provenance.url : stored?.book_url;
        if (url !== undefined) expect(url, `${c.id} ${field}: stored a non-http link`).toMatch(/^https?:\/\//);
        if (!/^https?:/i.test(c.input)) expect(stored, `${c.id} ${field}: the row with a ${c.input.split(":")[0]}: link was stored`).toBeUndefined();
      }
      // a place name that is a URL is a search term, never an address
      for (const [name, args] of [
        ["rumbo_plan_choose", { plan_id: SEED.plan, place: c.input.slice(0, 80) }],
        ["rumbo_plan_start", { destination: c.input.slice(0, 80) }],
        ["rumbo_watch_add", { ...(BASE.rumbo_watch_add as object), place: c.input }],
      ] as const) {
        seen.length = 0;
        const a = await call(name, args);
        expect(a.status, `${c.id} ${name}`).toBe(200);
        expect(a.json?.error ?? "", `${c.id} ${name}`).not.toBe("internal");
        for (const s of seen) {
          expect(allowedHosts, `${c.id} ${name}: ${s.host}`).toContain(s.host);
          if (attackerHost) expect(s.host, `${c.id} ${name}`).not.toBe(attackerHost);
        }
      }
    }
  }, 120_000);
});

describe("oversize and wrong-type arguments", () => {
  it("a 2 MB body, a 2 MB nested array and a lying Content-Length are 413 on every tool, never a 500", async () => {
    const text = family("oversize").find((c) => c.id.endsWith("text"))!;
    const nested = family("oversize").find((c) => c.id.endsWith("nested"))!;
    for (const name of Object.keys(BASE)) {
      const big = toolCall(name, { padding: valueOf(text) });
      const res = await post(big);
      expect(res.status, `${name} 2 MB string`).toBe(413);
      expect(await res.text()).not.toMatch(/stack|at .*\(.*:\d+/);
    }
    const resNested = await post(valueOf(nested));
    expect(resNested.status, "2 MB of '['").toBe(413);
    const lying = await post(toolCall("rumbo_feed", {}), { "content-length": "5000000" });
    expect(lying.status).toBe(413);
  }, 60_000);

  it("a field over its schema limit is refused as invalid_input", async () => {
    const long = "x".repeat(100_000);
    for (const [name, path] of [["rumbo_profile_update", ["note"]], ["rumbo_feedback", ["note"]], ["rumbo_plan_start", ["text"]], ["rumbo_plan_choose", ["place"]], ["rumbo_agent_brief", ["agent"]]] as const) {
      const a = await call(name, withValue(BASE[name], [...path], long));
      expect(a.isError, name).toBe(true);
      expect(a.json?.error, name).toBe("invalid_input");
    }
    const many = await call("rumbo_observe", { agent: AGENT, observations: Array.from({ length: 101 }, (_, i) => idea(`i${i}`)) });
    expect(many.json?.error).toBe("invalid_input");
  });

  it("a wrong type is a schema error (-32602 or invalid_input), never a 500, and no handler runs", async () => {
    const listed = ((await (await post(rpc("tools/list"))).json()) as { result: { tools: { name: string; inputSchema: { properties?: Record<string, { type?: string; enum?: unknown[] }> } }[] } }).result.tools;
    let checked = 0;
    for (const tool of listed) {
      const handlers = spies();
      for (const [prop, def] of Object.entries(tool.inputSchema.properties ?? {})) {
        const wrong = def.type === "string" ? 12345 : def.type === "integer" || def.type === "number" ? "not-a-number" : def.type === "boolean" ? "yes" : def.type === "array" ? "not-an-array" : def.type === "object" ? ["not", "an", "object"] : undefined;
        if (wrong === undefined) continue;
        const a = await call(tool.name, { ...(BASE[tool.name] as object), [prop]: wrong });
        checked++;
        expect(a.status, `${tool.name}.${prop}`).toBe(200);
        const refused = a.rpcError?.code === -32602 || (a.isError && a.json?.error === "invalid_input");
        expect(refused, `${tool.name}.${prop} <- ${JSON.stringify(wrong)}: ${a.text.slice(0, 160)}`).toBe(true);
        expect(a.rpcError?.code).not.toBe(-32603);
      }
      for (const bad of ["a string", 42, ["array"]]) {
        const a = await call(tool.name, bad);
        expect(a.status).toBe(200);
        expect(a.rpcError?.code === -32602 || (a.isError && a.json?.error === "invalid_input"), `${tool.name} args=${JSON.stringify(bad)}: ${JSON.stringify(a.rpcError)} ${a.text.slice(0, 200)}`).toBe(true);
      }
      expect(handlers.every((h) => h.spy.mock.calls.length === 0), `${tool.name}: a handler ran for a wrong type`).toBe(true);
      handlers.forEach((h) => h.spy.mockRestore());
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("canaries", () => {
  /** Where each stored text may legitimately come back: the tool that owns the record and the tools that read it. */
  const WRITERS_OF_TEXT: { writer: string; path: Path; readers: string[] }[] = [
    { writer: "rumbo_profile_update", path: ["note"], readers: ["rumbo_profile_update", "rumbo_profile_get", "rumbo_agent_brief"] },
    { writer: "rumbo_watch_add", path: ["label"], readers: ["rumbo_watch_add", "rumbo_watch_list", "rumbo_agent_brief"] },
    { writer: "rumbo_feedback", path: ["note"], readers: [] },
    { writer: "rumbo_import_history", path: ["trips", 0, "title"], readers: [] },
    { writer: "rumbo_observe", path: ["observations", 0, "title"], readers: ["rumbo_feed"] },
    { writer: "rumbo_plan_start", path: ["text"], readers: ["rumbo_plan_start", "rumbo_plan_get"] },
  ];

  it("a canary sent to one tool is in no other tool's answer and in no outbound request", async () => {
    for (const c of family("encoded-canary")) {
      const forms = canaryForms(c.canary!).map(stripInvisible);
      for (const w of WRITERS_OF_TEXT) {
        reseed(); // the previous writer's text must not count as this writer's leak
        seen.length = 0;
        const written = await call(w.writer, withValue(BASE[w.writer], w.path, c.input));
        expect(written.status, `${c.id} -> ${w.writer}`).toBe(200);
        const returned: string[] = [];
        for (const name of Object.keys(BASE)) {
          const a = await call(name, BASE[name]);
          if (forms.some((f) => stripInvisible(a.text).includes(f))) returned.push(name);
        }
        const extra = returned.filter((n) => !w.readers.includes(n));
        expect(extra, `${c.id}: text sent to ${w.writer} came back from`).toEqual([]);
        for (const s of seen) for (const f of forms) expect(stripInvisible(s.text).includes(f), `${c.id} sent to ${w.writer} reached ${s.url}`).toBe(false);
        const s = store.createStore(store.db());
        for (const x of s.listWatches()) if (x.id !== SEED.watch) s.deleteWatch(x.id);
      }
    }
  }, 120_000);
});
