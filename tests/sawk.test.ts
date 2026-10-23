import { describe, expect, it, vi } from "vitest";
import { ObservationSchema } from "../src/core/schema";
import { mapSawkEvent, sawk, sawkConfigured, sawkEvents } from "../src/server/sawk";
import { createMemoryLedger, runSources } from "../src/server/sources";
import { NOW } from "./plan-support";

const ENV = { SAWK_URL: "https://sawk.example.test/functions/v1/sawk/", SAWK_TOKEN: "secret-token-123" };

const event = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  title: "Jazz at Jimmy Glass",
  startsAt: "2026-12-06T22:00:00+01:00",
  endsAt: "2026-12-07T00:30:00+01:00",
  city: "Valencia",
  country: "ES",
  venue: "Jimmy Glass Jazz Bar",
  category: "music",
  priceMin: 12.5,
  currency: "EUR",
  isFree: false,
  url: "https://venue.example.test/jazz",
  ticketUrl: "https://tickets.example.test/jazz",
  ...over,
});

function feedFetch(items: unknown[], status = 200) {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ from: "2026-12-05", to: "2026-12-09", items }), { status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

describe("mapSawkEvent", () => {
  it("maps a SAWk event to an event observation with provenance source sawk", () => {
    const o = mapSawkEvent(event(), NOW, "Valencia")!;
    expect(ObservationSchema.safeParse(o).success).toBe(true);
    expect(o).toMatchObject({
      kind: "event",
      title: "Jazz at Jimmy Glass",
      place: "Valencia",
      country: "ES",
      date: "2026-12-06", // the local day, from the offset in startsAt
      end_date: "2026-12-07",
      venue: "Jimmy Glass Jazz Bar",
      tags: ["concerts"],
      book_url: "https://tickets.example.test/jazz",
      price_from: { amount_minor: 1250, currency: "EUR" },
    });
    expect(o.provenance).toMatchObject({ source: "sawk", url: "https://venue.example.test/jazz", seen_at: NOW.toISOString() });
    expect(o.provenance.expires_at).toBe("2026-12-06T23:30:00.000Z"); // the event's end
  });

  it("gives the same id for the same event and a different one for another", () => {
    expect(mapSawkEvent(event(), NOW, "Valencia")!.id).toBe(mapSawkEvent(event({ title: "Renamed" }), NOW, "Valencia")!.id);
    expect(mapSawkEvent(event({ id: "e2" }), NOW, "Valencia")!.id).not.toBe(mapSawkEvent(event(), NOW, "Valencia")!.id);
  });

  it("handles free events, no price, no end, and an unknown category", () => {
    expect(mapSawkEvent(event({ isFree: true, priceMin: null }), NOW, "Valencia")!).toMatchObject({ price_from: { amount_minor: 0, currency: "EUR" } });
    const bare = mapSawkEvent(event({ priceMin: null, currency: null, endsAt: null, category: "meetup", ticketUrl: null }), NOW, "Valencia")!;
    expect(bare.kind === "event" && bare.price_from).toBeUndefined();
    expect(bare.tags).toEqual([]);
    expect(bare.book_url).toBe("https://venue.example.test/jazz");
    expect(bare.provenance.expires_at).toBe("2026-12-07T01:00:00.000Z"); // start + 4 h
    expect(bare.kind === "event" && bare.end_date).toBeUndefined();
  });

  it("skips cancelled events and rows it cannot read", () => {
    expect(mapSawkEvent(event({ cancelled: true }), NOW, "Valencia")).toBeNull();
    expect(mapSawkEvent(event({ startsAt: "soon" }), NOW, "Valencia")).toBeNull();
    expect(mapSawkEvent(event({ title: "" }), NOW, "Valencia")).toBeNull();
    expect(mapSawkEvent(null as never, NOW, "Valencia")).toBeNull();
  });
});

describe("sawkEvents", () => {
  it("returns [] and calls nothing without both env vars", async () => {
    const f = vi.fn();
    for (const env of [{}, { SAWK_URL: ENV.SAWK_URL }, { SAWK_TOKEN: "x" }]) {
      expect(await sawkEvents("Valencia", "ES", { from: "2026-12-05", to: "2026-12-09" }, { env, fetch: f as unknown as typeof fetch })).toEqual([]);
    }
    expect(f).not.toHaveBeenCalled();
    expect(sawkConfigured({})).toBe(false);
    expect(sawkConfigured(ENV)).toBe(true);
  });

  it("reads /api/feed with the city, the window, limit 20 and the bearer token", async () => {
    const { fetch, seen } = feedFetch([{ event: event(), score: 0.9, reason: "jazz" }, { event: event({ id: "e2", title: "Opera" }) }, { event: event({ cancelled: true, id: "e3" }) }]);
    const out = await sawkEvents("Valencia", "ES", { from: "2026-12-05", to: "2026-12-09" }, { env: ENV, fetch, now: NOW });
    expect(out.map((o) => o.title)).toEqual(["Jazz at Jimmy Glass", "Opera"]);
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0]!.url);
    expect(u.origin + u.pathname).toBe("https://sawk.example.test/functions/v1/sawk/api/feed");
    expect(Object.fromEntries(u.searchParams)).toEqual({ city: "Valencia", from: "2026-12-05", to: "2026-12-09", limit: "20" });
    expect(seen[0]!.auth).toBe("Bearer secret-token-123");
  });

  it("deduplicates repeated events and caps at 20 items", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ event: event({ id: `x${i % 25}` }) }));
    const out = await sawkEvents("Valencia", "ES", { from: "2026-12-05", to: "2026-12-09" }, { env: ENV, fetch: feedFetch(items).fetch, now: NOW });
    expect(out.length).toBeLessThanOrEqual(20);
    expect(new Set(out.map((o) => o.id)).size).toBe(out.length);
  });

  it("throws a SourceError that never contains the token", async () => {
    const err = await sawkEvents("Valencia", "ES", { from: "2026-12-05", to: "2026-12-09" }, { env: ENV, fetch: feedFetch([], 401).fetch }).catch((e) => e);
    expect(err.name).toBe("SourceError");
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain("secret-token-123");
  });
});

describe("sawk as a Source", () => {
  it("is off without env and says which variable to set", () => {
    expect(sawk.enabled({})).toBe(false);
    expect(sawk.why_disabled({})).toMatch(/SAWK_URL/);
    expect(sawk.why_disabled({ SAWK_URL: "https://x.test" })).toMatch(/SAWK_TOKEN/);
    expect(sawk.enabled(ENV)).toBe(true);
    expect(sawk.why_disabled(ENV)).toBeNull();
  });

  it("runs through runSources with the daily cap and records a failure", async () => {
    const ledger = createMemoryLedger();
    const q = { kind: "events" as const, place: "Valencia", country: "ES", window: { from: "2026-12-05", to: "2026-12-09" } };
    const ok = await runSources([q], { sources: [sawk], ledger, env: ENV, now: NOW, fetch: feedFetch([{ event: event() }]).fetch });
    expect(ok.observations).toHaveLength(1);
    expect(ok.calls).toEqual([{ source: "sawk", n: 1, ok: true }]);
    const bad = await runSources([q], { sources: [sawk], ledger, env: ENV, now: NOW, fetch: feedFetch([], 500).fetch });
    expect(bad.observations).toEqual([]);
    expect(bad.calls[0]).toMatchObject({ source: "sawk", ok: false });
    const off = await runSources([q], { sources: [sawk], ledger, env: {}, now: NOW });
    expect(off.calls[0]).toMatchObject({ skipped: "disabled" });
  });
});
