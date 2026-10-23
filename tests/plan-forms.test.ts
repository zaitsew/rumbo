import { describe, expect, it } from "vitest";
import { parseChooseForm, parsePlanForm } from "../src/server/plan-forms";

function fd(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

describe("parsePlanForm", () => {
  it("passes the sentence alone", () => {
    expect(parsePlanForm(fd({ text: "  a week in Rome " }), "EUR")).toEqual({ ok: true, value: { text: "a week in Rome" } });
  });

  it("reads every field of the details form", () => {
    const r = parsePlanForm(fd({
      text: "kitesurf", window_from: "2026-12-01", window_to: "2026-12-31", nights_min: "3", nights_max: "5",
      adults: "2", children: "1", budget: "600,50", interest: ["kitesurf", "food", "bogus"], destination: " Tarifa ", car: "on",
    }), "EUR");
    expect(r).toEqual({
      ok: true,
      value: {
        text: "kitesurf",
        request: {
          window: { from: "2026-12-01", to: "2026-12-31" },
          nights: { min: 3, max: 5 },
          travellers: { adults: 2, children: 1 },
          budget_total: { amount_minor: 60050, currency: "EUR" },
          interests: ["kitesurf", "food"],
          destination: "Tarifa",
          needs: ["flights", "stay", "car", "activities", "events"],
        },
      },
    });
  });

  it("fills one night count into both ends", () => {
    const r = parsePlanForm(fd({ nights_min: "4" }), "EUR");
    expect(r).toEqual({ ok: true, value: { request: { nights: { min: 4, max: 4 } } } });
  });

  it("explains each mistake", () => {
    const bad = (e: Record<string, string>) => {
      const r = parsePlanForm(fd(e), "EUR");
      return r.ok ? "ok" : r.error;
    };
    expect(bad({})).toMatch(/Describe the trip/);
    expect(bad({ text: "   " })).toMatch(/Describe the trip/);
    expect(bad({ window_from: "2026-12-01" })).toMatch(/both dates/);
    expect(bad({ window_from: "2026-12-09", window_to: "2026-12-01" })).toMatch(/cannot end/);
    expect(bad({ nights_min: "0" })).toMatch(/whole numbers/);
    expect(bad({ nights_min: "5", nights_max: "2" })).toMatch(/cannot be below/);
    expect(bad({ nights_min: "2.5" })).toMatch(/whole numbers/);
    expect(bad({ adults: "0" })).toMatch(/at least one adult/);
    expect(bad({ budget: "-5" })).toMatch(/positive/);
    expect(bad({ budget: "lots" })).toMatch(/positive/);
  });

  it("converts the budget with the currency's own minor unit", () => {
    const r = parsePlanForm(fd({ budget: "90000" }), "JPY");
    expect(r).toMatchObject({ ok: true, value: { request: { budget_total: { amount_minor: 90000, currency: "JPY" } } } });
  });
});

describe("parseChooseForm", () => {
  it("needs the plan and the place; dates are optional but come as a pair", () => {
    expect(parseChooseForm(fd({ id: "pl_1", place: "Rome" }))).toEqual({ ok: true, value: { id: "pl_1", place: "Rome" } });
    expect(parseChooseForm(fd({ id: "pl_1", place: "Rome", from: "2026-12-01", to: "2026-12-04" }))).toEqual({ ok: true, value: { id: "pl_1", place: "Rome", dates: { from: "2026-12-01", to: "2026-12-04" } } });
    expect(parseChooseForm(fd({ id: "pl_1", place: "Rome", from: "2026-12-01" })).ok).toBe(false);
    expect(parseChooseForm(fd({ place: "Rome" })).ok).toBe(false);
    expect(parseChooseForm(fd({ id: "pl_1" })).ok).toBe(false);
  });
});
