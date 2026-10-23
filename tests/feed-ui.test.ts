import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "../src/core/schema";
import { getFeed, recordFeedback } from "../src/server/feed";
import { FEEDBACK_BUTTONS, KIND_FILTERS, feedbackFromForm, parseKindParam } from "../src/server/feed-ui";
import { WHY_TOP, resetWhyCache, withWhy } from "../src/server/feed-why";
import { createStore, openDb, type Db, type Store } from "../src/server/store";
import { PROFILE, flight } from "./helpers";

const NOW = new Date("2026-10-23T12:00:00Z");
const ON = { ACCOUNTS_SERVICE_RUMBO: "svc-token" };

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("kind filters", () => {
  it("offers the six kinds and ignores anything else", () => {
    expect([...KIND_FILTERS].sort()).toEqual(["activity", "car", "event", "flight", "idea", "stay"]);
    expect(parseKindParam("flight")).toBe("flight");
    expect(parseKindParam(["stay", "event"])).toBe("stay");
    expect(parseKindParam("hotel")).toBeUndefined();
    expect(parseKindParam(undefined)).toBeUndefined();
  });
});

describe("feedback buttons", () => {
  it("maps like, dislike and hide to the ranker's actions", () => {
    expect(feedbackFromForm(form({ observation_id: "o1", button: "like" }))).toMatchObject({ ok: true, feedback: { observation_id: "o1", action: "more-like-this" } });
    expect(feedbackFromForm(form({ observation_id: "o1", button: "dislike" }))).toMatchObject({ ok: true, feedback: { action: "less-like-this" } });
    expect(feedbackFromForm(form({ observation_id: " o1 ", button: "hide" }))).toMatchObject({ ok: true, feedback: { observation_id: "o1", action: "dismissed" } });
    expect(Object.keys(FEEDBACK_BUTTONS)).toEqual(["like", "dislike", "hide"]);
  });

  it("refuses a missing item, an unknown button and prototype keys", () => {
    expect(feedbackFromForm(form({ button: "like" }))).toMatchObject({ ok: false });
    expect(feedbackFromForm(form({ observation_id: "o1" }))).toMatchObject({ ok: false });
    expect(feedbackFromForm(form({ observation_id: "o1", button: "booked" }))).toMatchObject({ ok: false });
    expect(feedbackFromForm(form({ observation_id: "o1", button: "toString" }))).toMatchObject({ ok: false });
  });
});

describe("hide and like through recordFeedback", () => {
  let db: Db;
  let s: Store;
  beforeEach(() => {
    db = openDb(":memory:");
    s = createStore(db);
    s.putProfile(PROFILE);
    s.upsertObservations([flight("a", { provenance: { source: "kiwi-mcp", url: "https://example.com/a", seen_at: "2026-10-23T09:00:00Z", expires_at: "2026-10-26T09:00:00Z" } })]);
  });
  afterEach(() => db.close());

  it("hide removes the item from the feed; like keeps it and ties to the same observation", () => {
    const fb = (button: string) => {
      const p = feedbackFromForm(form({ observation_id: "a", button }));
      if (!p.ok) throw new Error(p.error);
      recordFeedback("owner", p.feedback, s, NOW);
    };
    fb("like");
    expect(getFeed("owner", { now: NOW }, s).map((i) => i.observation.id)).toEqual(["a"]);
    fb("hide");
    expect(getFeed("owner", { now: NOW }, s)).toEqual([]);
  });

  it("filters the feed by kind", () => {
    expect(getFeed("owner", { now: NOW, kinds: ["flight"] }, s)).toHaveLength(1);
    expect(getFeed("owner", { now: NOW, kinds: ["event"] }, s)).toHaveLength(0);
  });
});

describe("withWhy", () => {
  beforeEach(() => resetWhyCache());

  const item = (id: string, reasons: string[] = ["€38 below the usual fare"]): FeedItem => ({
    observation: flight(id),
    score: 0.8,
    parts: { deal: 0.8, fit: 0.5, taste: 0.5, urgency: 0.5, novelty: 0.5 },
    reasons,
    stale: false,
    state: "new",
  });

  function hub(sentence: string) {
    const calls: unknown[] = [];
    const f = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "write_reason", arguments: JSON.stringify({ sentence }) } }] } }] }));
    }) as typeof fetch;
    return { fetch: f, calls };
  }

  it("does nothing, and calls nothing, when the AI is off", async () => {
    const f = vi.fn();
    const items = [item("a")];
    expect(await withWhy(items, { ai: { env: {}, fetch: f as unknown as typeof fetch }, now: NOW })).toBe(items);
    expect(f).not.toHaveBeenCalled();
  });

  it("adds a grounded line to the top items only, and serves a repeat from the cache", async () => {
    const { fetch, calls } = hub("38 euros under the usual fare.");
    const items = Array.from({ length: WHY_TOP + 2 }, (_, i) => item(`f${i}`));
    const first = await withWhy(items, { ai: { env: ON, fetch }, now: NOW });
    expect(first.slice(0, WHY_TOP).every((i) => i.why === "38 euros under the usual fare.")).toBe(true);
    expect(first.slice(WHY_TOP).every((i) => i.why === undefined)).toBe(true);
    expect(calls).toHaveLength(WHY_TOP);
    await withWhy(items, { ai: { env: ON, fetch }, now: new Date(NOW.getTime() + 60_000) });
    expect(calls).toHaveLength(WHY_TOP); // cached
  });

  it("drops a line with a number the reasons do not hold, and remembers the miss for a while", async () => {
    const { fetch, calls } = hub("About 40 euros cheaper than usual.");
    const out = await withWhy([item("a")], { ai: { env: ON, fetch }, now: NOW });
    expect(out[0]!.why).toBeUndefined();
    await withWhy([item("a")], { ai: { env: ON, fetch }, now: new Date(NOW.getTime() + 60_000) });
    expect(calls).toHaveLength(1);
    await withWhy([item("a")], { ai: { env: ON, fetch }, now: new Date(NOW.getTime() + 11 * 60_000) });
    expect(calls).toHaveLength(2);
  });
});
