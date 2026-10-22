import { describe, expect, it } from "vitest";
import { toLocoProposal } from "../src/core/loco";
import { PlanSchema, type Observation, type Plan } from "../src/core/schema";

const prov = { source: "kiwi-mcp", url: "https://www.kiwi.com/x", seen_at: "2026-10-23T08:00:00+02:00", expires_at: "2026-10-25T08:00:00+02:00" };
const flight: Observation = {
  kind: "flight", id: "fl:VLC-LIS:1206", title: "VLC to LIS", place: "Lisbon", tags: [], provenance: prov,
  origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-09",
  price: { amount_minor: 8900, currency: "EUR" }, stops: 0, duration_minutes: 155, seller: "Kiwi.com", book_url: "https://www.kiwi.com/book/1",
  legs: [{ from: "VLC", to: "LIS", depart_at: "2026-12-06T07:10:00+01:00", arrive_at: "2026-12-06T08:45:00+00:00", carrier: "Vueling", flight_no: "VY1234" }],
};
const stay: Observation = {
  kind: "stay", id: "st:1", title: "Loft in Alfama", name: "Loft in Alfama", place: "Lisbon", tags: [], rating: 8.9,
  provenance: { source: "claude:booking-connector", seen_at: "2026-10-23T09:00:00+02:00" }, check_in: "2026-12-06", check_out: "2026-12-09",
  price_total: { amount_minor: 31050, currency: "EUR" }, stay_kind: "apartment", book_url: "https://www.booking.com/hotel/x",
};
const car: Observation = {
  kind: "car", id: "car:1", title: "Compact car", place: "Lisbon", tags: [], provenance: { source: "owner", seen_at: "2026-10-23T09:00:00+02:00" },
  pickup_date: "2026-12-06", dropoff_date: "2026-12-09", pickup: "LIS", price_total: { amount_minor: 12000, currency: "EUR" },
};
const activity: Observation = {
  kind: "activity", id: "act:1", title: "Sintra day trip", place: "Lisbon", tags: ["culture"], provenance: { source: "viator", seen_at: "2026-10-23T09:00:00+02:00" },
  date: "2026-12-07", price: { amount_minor: 4500, currency: "EUR" },
};
const event: Observation = {
  kind: "event", id: "ev:1", title: "Fado night", place: "Lisbon", tags: ["concerts"], provenance: { source: "ticketmaster", seen_at: "2026-10-23T09:00:00+02:00" },
  date: "2026-12-08", venue: "Teatro", price_from: { amount_minor: 2500, currency: "EUR" },
};
const idea: Observation = { kind: "idea", id: "idea:1", title: "Kite week", place: "Lisbon", tags: [], provenance: { source: "grok-task", seen_at: "2026-10-23T09:00:00+02:00" }, summary: "x" };
const all = [flight, stay, car, activity, event, idea];

const plan: Plan = PlanSchema.parse({
  id: "p1", created_at: "2026-10-23T10:00:00+02:00", status: "ready",
  request: { window: { from: "2026-12-04", to: "2026-12-12" }, nights: { min: 3, max: 3 } },
  candidates: [{ place: "Lisbon", country: "Portugal", airports: ["LIS"], score: 0.8, reasons: [] }],
  chosen: "Lisbon", dates: { from: "2026-12-06", to: "2026-12-09" },
  sections: { flights: [flight.id], stay: [stay.id], car: [car.id], activities: [activity.id, idea.id], events: [event.id, "missing"] },
  links: [],
});

describe("toLocoProposal", () => {
  const args = toLocoProposal(plan, all, { slug: "lisbon-dec" });
  const p = args.proposal;
  const opt = (id: string) => p.options.find((o) => o.id.includes(id))!;

  it("makes one inbox proposal with one option per bookable observation", () => {
    expect(args.slug).toBe("lisbon-dec");
    expect(p.kind).toBe("other");
    expect(p.createdBy).toBe("rumbo");
    expect(p.id).toBe("rumbo-plan-p1");
    expect(p.title).toBe("Lisbon, 6–9 Dec");
    expect(p.summary.startsWith("intake: rumbo · 5 options")).toBe(true);
    expect(p.options.map((o) => o.title)).toEqual(["VLC → LIS, 6–9 Dec", "Loft in Alfama", "Compact car", "Sintra day trip", "Fado night"]);
  });

  it("converts money from minor to major units", () => {
    expect(opt("fl").price).toEqual({ amount: 89, currency: "EUR" });
    expect(opt("st").price).toEqual({ amount: 310.5, currency: "EUR" });
    expect(opt("act").price).toEqual({ amount: 45, currency: "EUR" });
  });

  it("maps a flight to an air move with local clock times and a day offset", () => {
    const move = opt("fl").move as Record<string, any>;
    expect(move).toMatchObject({ date: "2026-12-06", mode: "air", status: "proposed", fromPlaceId: "VLC", toPlaceId: "LIS", carrier: "Vueling", who: [] });
    expect(move.legs).toHaveLength(1);
    expect(move.legs[0]).toMatchObject({ number: "VY1234", dep: "07:10", arr: "08:45", arrDayOffset: 0, fromCode: "VLC", toCode: "LIS", date: "2026-12-06" });
    expect(opt("fl").details).toContain("Return on 2026-12-09 is part of this fare");
    expect(opt("fl").details).toContain("direct");
  });

  it("maps stays, cars, activities and events to Loco items, all proposed", () => {
    expect(opt("st").stay).toMatchObject({ placeId: "LIS", checkIn: "2026-12-06", checkOut: "2026-12-09", status: "proposed", name: "Loft in Alfama", platform: "claude:booking-connector", who: [] });
    expect(opt("car").event).toMatchObject({ category: "car", date: "2026-12-06", status: "proposed" });
    expect(opt("act").event).toMatchObject({ category: "sight", date: "2026-12-07" });
    expect(opt("ev").event).toMatchObject({ category: "show", date: "2026-12-08", venue: "Teatro" });
  });

  it("never marks anything booked", () => {
    const text = JSON.stringify(args);
    expect(text).not.toMatch(/"status":"booked"/);
    for (const o of p.options) {
      const item = (o.move ?? o.stay ?? o.event) as { status: string };
      expect(item.status).toBe("proposed");
    }
  });

  it("carries provenance on every option: seen at, price and url, repeated in details", () => {
    for (const o of p.options) {
      expect(o.seen.by).toBe("rumbo");
      expect(o.seen.at).toMatch(/^2026-10-23T/);
      expect(o.details).toContain(`Seen ${o.seen.at} on `);
      expect(o.details).toContain("Check the price on the page before booking.");
    }
    expect(opt("fl").seen).toMatchObject({ at: prov.seen_at, url: "https://www.kiwi.com/book/1", price: { amount: 89, currency: "EUR" } });
    expect(opt("fl").url).toBe("https://www.kiwi.com/book/1");
    expect(opt("fl").details).toContain("valid until 2026-10-25T08:00:00+02:00");
    expect(opt("car").seen.url).toBeUndefined();
  });

  it("keeps the argument shape of loco_propose (ids, no unknown option keys)", () => {
    const allowed = new Set(["id", "title", "details", "url", "imageURL", "price", "placeId", "stay", "move", "event", "seen"]);
    for (const o of p.options) for (const k of Object.keys(o)) expect(allowed.has(k), k).toBe(true);
    expect(new Set(p.options.map((o) => o.id)).size).toBe(p.options.length);
    expect(() => JSON.stringify(args)).not.toThrow();
  });

  it("refuses an empty plan", () => {
    expect(() => toLocoProposal({ ...plan, sections: { flights: [], stay: [], car: [], activities: [], events: [] } }, all)).toThrow(/no observations/);
  });
});
