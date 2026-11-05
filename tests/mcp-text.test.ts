import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICE_DISCLAIMER } from "../src/server/mcp/format";
import { BRIEF_RULES } from "../src/server/brief";
import { MCP_INSTRUCTIONS, listedTools, runTool } from "../src/server/mcp/server";
import { TOOLS, toolByName } from "../src/server/mcp/tools";
import { createStore, openDb, type Db, type Store } from "../src/server/store";
import { PROFILE, flight, tempDir, watch } from "./helpers";

// Anthropic directory review (BankJar, 2026-11-04): instructions, descriptions and tool outputs describe
// what the server does; they carry no command aimed at the assistant. Policy: ~/.agents/POLICY.md §15.
// This file scans every string the MCP server writes itself. Words inside stored user or web content are
// data and are not scanned, so the fixtures below are written to stay clear of the words.

vi.mock("../src/server/sources", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/sources")>();
  const support = await import("./plan-support");
  return { ...real, ALL_SOURCES: [support.fakeFlights(), support.fakeStays(), support.fakeActivities(), support.fakeEvents()] };
});

/** BankJar's scan, unchanged. */
const COMMANDS = /\b(always|never|must|should|cite|tell|ask|say|do not|don't|make sure|remember|check|use|pass|give|leave|recommend)\b/i;
/** A sentence that opens with an imperative verb: "Call X", "Report Y", "Leave out Z". */
const IMPERATIVE_OPENER =
  /(^|[.;:!?]\s+)(call|search|report|post|copy|find|skip|read|ignore|send|fix|pick|show|choose|add|set|put|keep|start|follow|try|wait|confirm|verify|summarise|summarize|pick|prefer|include|treat|mark|record|open|offer|please|note|avoid|stop|make|pass|ask|use|check|give|leave|never|always|do|don't)\s+\S/i;

function scan(label: string, text: string): void {
  expect(text, label).not.toMatch(COMMANDS);
  expect(text, label).not.toMatch(IMPERATIVE_OPENER);
}

/** Scans each string of a result on its own, so a failure names the string. */
function scanAll(label: string, value: unknown): void {
  for (const text of strings(value)) scan(`${label}: ${text.slice(0, 80)}`, text);
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Every `description` anywhere in a JSON schema. */
function descriptions(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) for (const v of schema) descriptions(v, out);
  else if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else descriptions(v, out);
    }
  }
  return out;
}

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
  scanAll(`${name} ${JSON.stringify(args).slice(0, 60)}`, body);
  return { isError: res.isError === true, body };
}

describe("MCP text states facts and gives no commands to the assistant", () => {
  it("the server instructions, the brief rules and the price disclaimer carry no commands", () => {
    scan("instructions", MCP_INSTRUCTIONS);
    for (const rule of BRIEF_RULES) scan(`brief rule: ${rule.slice(0, 40)}`, rule);
    scan("disclaimer", PRICE_DISCLAIMER);
    expect(MCP_INSTRUCTIONS).toContain("provenance.url");
    expect(MCP_INSTRUCTIONS).toContain("not quotes");
  });

  it("every tool title, description and parameter description carries no commands", () => {
    const listed = listedTools();
    expect(listed).toHaveLength(TOOLS.length);
    for (const t of listed) {
      expect(t.title, `${t.name} title`).not.toMatch(COMMANDS); // a title is a label such as "Read a trip plan"
      scan(`${t.name} description`, t.description);
      for (const d of descriptions(t.inputSchema)) scan(`${t.name} parameter: ${d.slice(0, 40)}`, d);
    }
  });

  it("validation messages state what was refused and what is accepted", async () => {
    s.putProfile(PROFILE);
    await call("rumbo_feed", { limit: 0 });
    await call("rumbo_plan_start", {});
    await call("rumbo_plan_start", { text: "   " });
    await call("rumbo_plan_choose", { plan_id: "pl_x", place: "Lisbon", from: "2026-12-05" });
    await call("rumbo_observe", { agent: "x", observations: [] });
    await call("rumbo_profile_update", { agent: "bad name!", note: "a fact about trips" });
    await call("rumbo_profile_update", { agent: "owner", note: "a fact about trips" });
    await call("rumbo_profile_update", { agent: "claude-scheduled" });
    await call("rumbo_profile_update", { agent: "claude-scheduled", set: { home_airports: ["TOOLONG"] } });
    const notObject = await runTool(toolByName("rumbo_feed")!, [1], { store: s });
    scanAll("non-object arguments", JSON.parse(notObject.content[0]!.text));
  });

  it("feed, profile, feedback, history and observe outputs carry caveats as data", async () => {
    expect((await call("rumbo_feed", {})).body.note).toMatch(/No profile/);
    expect((await call("rumbo_profile_get", {})).body.note).toMatch(/No profile/);
    s.putProfile(PROFILE);
    s.upsertObservations([flight("f1", { provenance: { source: "kiwi-mcp", url: "https://example.com/o", seen_at: "2026-10-23T09:00:00Z", expires_at: "2026-10-26T09:00:00Z" } })]);
    const feed = await call("rumbo_feed", {});
    expect(feed.body.disclaimer).toBe(PRICE_DISCLAIMER);
    expect(feed.body.items.length).toBeGreaterThan(0);
    for (const i of feed.body.items) {
      expect(i.url).toMatch(/^https:/);
      expect(i.seen_at).toMatch(/^\d{4}-/);
      expect(typeof i.stale).toBe("boolean");
    }
    await call("rumbo_profile_get", {});
    await call("rumbo_profile_update", { agent: "claude-scheduled", note: "likes small hotels", set: { wishlist: ["Lisbon"] } });
    await call("rumbo_feedback", { observation_id: "f1", state: "saved" });
    await call("rumbo_feedback", { observation_id: "nope", state: "saved" });
    await call("rumbo_import_history", {
      trips: [{ id: "t1", title: "Lisbon", from: "2025-05-01", to: "2025-05-04", places: ["Lisbon"], rating: 5, tags: ["city"] }, { id: "t2", title: "Odd", from: "May", to: "2025-05-04", places: [] }],
    });
    const priced = flight("f2", { provenance: { source: "kiwi-mcp", seen_at: "2026-10-23T09:00:00Z" } }) as unknown as Record<string, unknown>;
    const rej = await call("rumbo_observe", { agent: "claude-scheduled", observations: [priced, { kind: "nonsense" }, "text"] });
    expect(rej.body.rejected).toHaveLength(3);
    await call("rumbo_observe", { agent: "claude-scheduled", observations: [flight("f3")], checked_watch_ids: ["none"] });
  });

  it("the notices a disabled source puts in a plan state what is missing", async () => {
    const real = await vi.importActual<typeof import("../src/server/sources")>("../src/server/sources");
    expect(real.ALL_SOURCES.length).toBeGreaterThan(3);
    for (const src of real.ALL_SOURCES) {
      for (const env of [{}, { RUMBO_KIWI_MCP: "0" }]) {
        const why = src.why_disabled(env as never);
        if (why) scan(`${src.name} why_disabled`, why);
      }
    }
  });

  it("watch tools carry no commands, including their refusals", async () => {
    s.upsertWatch(watch("mine", { created_by: "owner" }));
    await call("rumbo_watch_add", { kind: "place-events", label: "Lisbon events", place: "Lisbon", window: { from: "2026-12-01", to: "2026-12-31" }, agent: "claude-scheduled" });
    await call("rumbo_watch_add", { id: "mine", kind: "route", label: "x", window: { from: "2026-12-01", to: "2026-12-31" }, agent: "claude-scheduled" });
    await call("rumbo_watch_add", { id: "ghost", kind: "route", label: "x", window: { from: "2026-12-01", to: "2026-12-31" }, agent: "claude-scheduled" });
    await call("rumbo_watch_list", {});
  });

  it("the run brief describes the run in every shape it takes", async () => {
    const none = await call("rumbo_agent_brief", { agent: "claude-scheduled" });
    expect(none.body.profile_note).toMatch(/No profile/);
    s.putProfile({ ...PROFILE, wishlist: ["Lisbon"], busy: [{ from: "2026-12-12", to: "2026-12-14" }], free_windows: [{ from: "2026-12-01", to: "2026-12-31" }], stay: { min_rating: 8 }, budget: { night_max: { amount_minor: 15000, currency: "EUR" } } });
    const window = { from: "2026-12-01", to: "2026-12-31" };
    s.upsertWatch(watch("route", { max_price: { amount_minor: 9000, currency: "EUR" } }));
    s.upsertWatch(watch("any", { kind: "anywhere", destination: [] }));
    s.upsertWatch(watch("stays", { kind: "place-stays", place: "Lisbon", destination: [], origin: [], nights: { min: 3, max: 4 } }));
    s.upsertWatch(watch("events", { kind: "place-events", place: "Lisbon", destination: [], origin: [] }));
    s.upsertWatch(watch("acts", { kind: "place-activities", place: "Lisbon", destination: [], origin: [] }));
    s.upsertWatch(watch("over", { window: { from: "2026-01-01", to: "2026-02-01" } }));
    for (const connectors of [undefined, ["Booking.com", "Kiwi.com", "Viator", "web search"], ["Spotify"]]) {
      const b = (await call("rumbo_agent_brief", { agent: "claude-scheduled", ...(connectors ? { connectors } : {}) })).body;
      expect(b.due_watches.length).toBeGreaterThan(0);
      for (const w of b.due_watches) for (const q of w.searches) expect(typeof q.ask).toBe("string");
    }
    const b = (await call("rumbo_agent_brief", { agent: "claude-scheduled", connectors: ["Spotify"] })).body;
    expect(b.due_watches.flatMap((w: any) => w.searches.map((q: any) => q.connector))).toContain("deep-link"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(b.expired_watches).toHaveLength(1);
    expect(b.rules).toEqual(BRIEF_RULES);
    expect(window.from).toBe("2026-12-01");
  });

  it("plan tools carry the price caveat as data, and refuse in plain statements", async () => {
    expect((await call("rumbo_plan_start", { text: "a week in Lisbon" })).body.error).toBe("no_profile");
    s.putProfile({ ...PROFILE, home_city: "Valencia", home_airports: ["VLC"], currency: "EUR" });
    const started = await call("rumbo_plan_start", { text: "5 nights of food and culture in December" });
    expect(started.body.plan.disclaimer).toBe(PRICE_DISCLAIMER);
    const id = started.body.plan.id as string;
    await call("rumbo_plan_get", { plan_id: id });
    await call("rumbo_plan_get", {});
    await call("rumbo_plan_get", { plan_id: "pl_missing" });
    expect((await call("rumbo_to_loco", { plan_id: id, trip_slug: "t" })).body.error).toBe("nothing_to_propose");
    const place = started.body.plan.candidates[0].place as string;
    await call("rumbo_plan_choose", { plan_id: id, place, from: "2026-09-01", to: "2026-09-05" });
    const chosen = await call("rumbo_plan_choose", { plan_id: id, place, from: "2026-12-05", to: "2026-12-09" });
    expect(chosen.body.plan.disclaimer).toBe(PRICE_DISCLAIMER);
    expect(chosen.body.next).toMatch(/rumbo_to_loco/);
    const loco = await call("rumbo_to_loco", { plan_id: id, trip_slug: "t" });
    expect(loco.body.disclaimer).toBe(PRICE_DISCLAIMER);
    for (const o of loco.body.loco_propose_args.proposal.options) expect(o.details).toMatch(/sighting/);
    await call("rumbo_to_loco", { plan_id: "nope" });
    await call("rumbo_plan_choose", { plan_id: "pl_missing", place: "Lisbon" });
    await call("rumbo_plan_start", { destination: "Lisbon", nights: { min: 3, max: 3 }, window: { from: "2026-12-01", to: "2026-12-10" } });
    s.putPlan({ ...s.getPlan(id)!, status: "archived" }, NOW);
    await call("rumbo_plan_choose", { plan_id: id, place });
    await call("rumbo_plan_get", { plan_id: id });
  });
});
