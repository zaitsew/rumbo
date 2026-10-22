import { describe, expect, it } from "vitest";
import { formatWindows, parseProfileForm, parseProfileJson, parseWatchForm, parseWindows } from "../src/server/forms";
import { formatMoney, toMinor, observationPrice, isStale, observationFacts } from "../components/format";
import { flight } from "./helpers";
import { ProfileSchema } from "../src/core/schema";

function fd(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

describe("profile form", () => {
  const base = { home_city: "Valencia", home_airports: "vlc, alc", currency: "eur", adults: "2", children: "0" };

  it("parses airports, interests, budgets and windows", () => {
    const r = parseProfileForm(
      fd({
        ...base,
        interest_food: "2", interest_beach: "0", interest_ski: "-1",
        flight_max: "250", night_max: "180.5",
        max_stops: "0", max_hours_one_way: "6", stay_kind: ["hotel", "villa"],
        free_windows: "2026-12-05 2026-12-09 puente\n2027-03-01 2027-03-05",
        wishlist: "Lisbon\nMadeira, Tarifa",
      }),
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.home_airports).toEqual(["VLC", "ALC"]);
    expect(r.value.currency).toBe("EUR");
    expect(r.value.interests).toEqual({ food: 2, ski: -1 }); // neutral is not stored
    expect(r.value.budget.flight_max).toEqual({ amount_minor: 25000, currency: "EUR" });
    expect(r.value.budget.night_max).toEqual({ amount_minor: 18050, currency: "EUR" });
    expect(r.value.flight.max_stops).toBe(0);
    expect(r.value.stay.kinds).toEqual(["hotel", "villa"]);
    expect(r.value.free_windows).toEqual([{ from: "2026-12-05", to: "2026-12-09", note: "puente" }, { from: "2027-03-01", to: "2027-03-05" }]);
    expect(r.value.wishlist).toEqual(["Lisbon", "Madeira", "Tarifa"]);
  });

  it("keeps notes and busy days that the form does not show", () => {
    const existing = ProfileSchema.parse({
      home_city: "Valencia", home_airports: ["VLC"],
      busy: [{ from: "2026-11-01", to: "2026-11-03" }],
      notes: [{ text: "prefers aisle", provenance: { source: "claude", seen_at: "2026-10-23T08:00:00Z" } }],
    });
    const r = parseProfileForm(fd(base), existing);
    expect(r.ok && r.value.busy).toHaveLength(1);
    expect(r.ok && r.value.notes).toHaveLength(1);
  });

  it("says which field is wrong", () => {
    const r = parseProfileForm(fd({ ...base, home_airports: "", free_windows: "soon later" }), null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("home_airports");
      expect(r.error).toContain("free_windows");
    }
  });

  it("round-trips windows and rejects bad raw JSON", () => {
    const w = parseWindows("2026-12-05 2026-12-09 long weekend");
    expect(formatWindows(w)).toBe("2026-12-05 2026-12-09 long weekend");
    expect(parseProfileJson("{nope").ok).toBe(false);
    expect(parseProfileJson("{}").ok).toBe(false);
    expect(parseProfileJson('{"home_city":"V","home_airports":["VLC"]}').ok).toBe(true);
  });
});

describe("watch form", () => {
  const route = { kind: "route", destination: "lis, opo", window_from: "2026-12-01", window_to: "2026-12-31" };

  it("builds a route watch", () => {
    const r = parseWatchForm(fd({ ...route, nights_min: "2", nights_max: "4", max_price: "90" }), "EUR");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: "route", destination: ["LIS", "OPO"], origin: [], active: true, every_hours: 24 });
    expect(r.value.nights).toEqual({ min: 2, max: 4 });
    expect(r.value.max_price).toEqual({ amount_minor: 9000, currency: "EUR" });
    expect(r.value.label).toBe("Home to LIS/OPO");
    expect(r.value.id).toMatch(/^w_/);
  });

  it("builds a place watch and drops route-only fields", () => {
    const r = parseWatchForm(fd({ kind: "place-events", place: "Lisbon", destination: "LIS", window_from: "2026-12-01", window_to: "2026-12-31" }), "EUR");
    expect(r.ok && r.value).toMatchObject({ place: "Lisbon", destination: [], label: "Lisbon events" });
  });

  it("explains what is missing", () => {
    expect(parseWatchForm(fd({ ...route, destination: "" }), "EUR")).toMatchObject({ ok: false });
    expect(parseWatchForm(fd({ kind: "place-stays", window_from: "2026-12-01", window_to: "2026-12-02" }), "EUR")).toMatchObject({ ok: false });
    expect(parseWatchForm(fd({ ...route, nights_min: "2" }), "EUR")).toMatchObject({ ok: false });
    expect(parseWatchForm(fd({ ...route, window_to: "2026-11-01" }), "EUR")).toMatchObject({ ok: false, error: expect.stringContaining("ends before") });
  });
});

describe("formatting", () => {
  it("formats minor units", () => {
    expect(formatMoney({ amount_minor: 8900, currency: "EUR" })).toBe("€89");
    expect(formatMoney({ amount_minor: 8950, currency: "EUR" })).toBe("€89.50");
    expect(formatMoney({ amount_minor: 5000, currency: "JPY" })).toMatch(/5,000/);
    expect(toMinor(89.5, "EUR")).toBe(8950);
    expect(toMinor(5000, "JPY")).toBe(5000);
  });

  it("finds the price and the facts of an observation", () => {
    const f = flight("a");
    expect(observationPrice(f)).toEqual({ amount_minor: 8900, currency: "EUR" });
    expect(observationFacts(f)).toBe("VLC to LIS · 6 Dec to 9 Dec · direct");
  });

  it("knows stale", () => {
    expect(isStale("2026-10-01T00:00:00.000Z", new Date("2026-10-02T00:00:00Z"))).toBe(true);
    expect(isStale(null)).toBe(false);
  });
});
