import { describe, expect, it, vi } from "vitest";
import { AI_MODEL, aiEnabled, aiParsePlan, aiWhy, digitsAreGrounded, requestFromArguments } from "../src/server/ai";
import { ProfileSchema } from "../src/core/schema";

const profile = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], currency: "EUR" });
const ON = { ACCOUNTS_SERVICE_RUMBO: "svc-token" };

function toolFetch(args: unknown, status = 200) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    const name = seen[seen.length - 1]!.body.tool_choice.function.name;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] }), { status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

describe("aiEnabled", () => {
  it("is off without the hub token and when RUMBO_AI is off", () => {
    expect(aiEnabled({})).toBe(false);
    expect(aiEnabled({ ACCOUNTS_SERVICE_RUMBO: "  " })).toBe(false);
    expect(aiEnabled({ ...ON, RUMBO_AI: "off" })).toBe(false);
    expect(aiEnabled({ ...ON, RUMBO_AI: "OFF" })).toBe(false);
    expect(aiEnabled(ON)).toBe(true);
  });
});

describe("the off path", () => {
  it("never calls the network and returns null", async () => {
    const f = vi.fn();
    expect(await aiParsePlan("a week in Lisbon", "2026-10-23", profile, { env: {}, fetch: f as unknown as typeof fetch })).toBeNull();
    expect(await aiWhy(["in season in Dec"], "Lisbon", { env: { ...ON, RUMBO_AI: "off" }, fetch: f as unknown as typeof fetch })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("aiParsePlan", () => {
  it("sends one forced call to the hub for product rumbo with Haiku 5.5, and maps the arguments", async () => {
    const { fetch, seen } = toolFetch({
      destination: "Lisbon", window_from: "2026-12-01", window_to: "2026-12-31", nights_min: 4, nights_max: 4,
      adults: 2, children: null, interests: ["food", "not-an-interest"], budget_amount: 600, budget_currency: "eur", origin: ["vlc", "valencia"],
    });
    const out = await aiParsePlan("quiero ir a Lisboa en diciembre", "2026-10-23", profile, { env: ON, fetch });
    expect(out).toEqual({
      destination: "Lisbon",
      window: { from: "2026-12-01", to: "2026-12-31" },
      nights: { min: 4, max: 4 },
      travellers: { adults: 2, children: 0 },
      origin: ["VLC"],
      interests: ["food"],
      budget_total: { amount_minor: 60000, currency: "EUR" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://swgxlydagofazjtlqeiu.supabase.co/functions/v1/ai");
    expect(seen[0]!.headers["x-accounts-service"]).toBe("svc-token");
    expect(seen[0]!.headers["x-accounts-product"]).toBe("rumbo");
    expect(seen[0]!.body).toMatchObject({ product: "rumbo", model: AI_MODEL, fallback: [], tool_choice: { type: "function", function: { name: "set_trip_request" } } });
    expect(AI_MODEL).toBe("claude-haiku-5-5");
  });

  it("says in the prompt that the AI never prices anything", async () => {
    const { fetch, seen } = toolFetch({ destination: "Rome" });
    await aiParsePlan("Rome", "2026-10-23", profile, { env: ON, fetch });
    expect(seen[0]!.body.messages[0].content).toMatch(/never estimate a price/i);
  });

  it("drops dates that are in the past, malformed or reversed, and a budget in another currency keeps its code", () => {
    const base = { destination: "Rome" };
    expect(requestFromArguments({ ...base, window_from: "2026-01-01", window_to: "2026-01-09" }, "2026-10-23", profile)).toEqual({ destination: "Rome" });
    expect(requestFromArguments({ ...base, window_from: "2026-12-09", window_to: "2026-12-01" }, "2026-10-23", profile)).toEqual({ destination: "Rome" });
    expect(requestFromArguments({ ...base, window_from: "2026-02-31", window_to: "2026-12-01" }, "2026-10-23", profile)).toEqual({ destination: "Rome" });
    expect(requestFromArguments({ budget_amount: 1200, budget_currency: "usd" }, "2026-10-23", profile)).toEqual({ budget_total: { amount_minor: 120000, currency: "USD" } });
    expect(requestFromArguments({ budget_amount: 1200 }, "2026-10-23", profile)).toEqual({ budget_total: { amount_minor: 120000, currency: "EUR" } });
  });

  it("starts a window that has begun today, and fixes nights_max below nights_min", () => {
    expect(requestFromArguments({ window_from: "2026-10-01", window_to: "2026-11-30", nights_min: 5, nights_max: 2 }, "2026-10-23", profile)).toEqual({
      window: { from: "2026-10-23", to: "2026-11-30" },
      nights: { min: 5, max: 5 },
    });
  });

  it("returns null when the answer says nothing, is malformed, or the hub fails", async () => {
    expect(requestFromArguments({}, "2026-10-23", profile)).toBeNull();
    expect(requestFromArguments({ adults: "many" }, "2026-10-23", profile)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await aiParsePlan("x", "2026-10-23", profile, { env: ON, fetch: toolFetch({}).fetch })).toBeNull();
    expect(await aiParsePlan("x", "2026-10-23", profile, { env: ON, fetch: toolFetch({ destination: "Rome" }, 429).fetch })).toBeNull();
    const boom = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect(await aiParsePlan("x", "2026-10-23", profile, { env: ON, fetch: boom })).toBeNull();
    const slow = ((_u: string, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    expect(await aiParsePlan("x", "2026-10-23", profile, { env: ON, fetch: slow, timeoutMs: 20 })).toBeNull();
    warn.mockRestore();
  });
});

describe("aiWhy", () => {
  const reasons = ["€38 below the usual VLC–LIS fare", "fits 6–9 Dec free window"];

  it("keeps a sentence whose numbers all appear in the reasons", async () => {
    const { fetch, seen } = toolFetch({ sentence: "A fare 38 euros under the usual price that fits your 6–9 Dec window." });
    expect(await aiWhy(reasons, "VLC to LIS", { env: ON, fetch })).toBe("A fare 38 euros under the usual price that fits your 6–9 Dec window.");
    expect(seen[0]!.body.tool_choice.function.name).toBe("write_reason");
    expect(seen[0]!.body.messages[1].content).toContain("€38 below the usual VLC–LIS fare");
  });

  it("drops a sentence with a number that is not in the reasons", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await aiWhy(reasons, "VLC to LIS", { env: ON, fetch: toolFetch({ sentence: "About 40 euros cheaper than usual." }).fetch })).toBeNull();
    expect(await aiWhy(reasons, "VLC to LIS", { env: ON, fetch: toolFetch({ sentence: "Saves 380 euros." }).fetch })).toBeNull();
    warn.mockRestore();
  });

  it("returns null for no reasons, an empty or long sentence, and a missing field", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await aiWhy([], "x", { env: ON, fetch: toolFetch({ sentence: "Hi" }).fetch })).toBeNull();
    expect(await aiWhy(reasons, "x", { env: ON, fetch: toolFetch({ sentence: "  " }).fetch })).toBeNull();
    expect(await aiWhy(reasons, "x", { env: ON, fetch: toolFetch({ sentence: "a".repeat(300) }).fetch })).toBeNull();
    expect(await aiWhy(reasons, "x", { env: ON, fetch: toolFetch({}).fetch })).toBeNull();
    warn.mockRestore();
  });
});

describe("digitsAreGrounded", () => {
  it("compares whole digit sequences, not substrings", () => {
    expect(digitsAreGrounded("38 euros", ["€38 below"])).toBe(true);
    expect(digitsAreGrounded("380 euros", ["€38 below"])).toBe(false);
    expect(digitsAreGrounded("3 euros", ["€38 below"])).toBe(false);
    expect(digitsAreGrounded("no numbers here", ["€38"])).toBe(true);
    expect(digitsAreGrounded("6 to 9 Dec", ["fits 6–9 Dec"])).toBe(true);
    expect(digitsAreGrounded("in 2027", ["in 2026"])).toBe(false);
  });
});
