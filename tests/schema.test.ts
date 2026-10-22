import { describe, expect, it } from "vitest";
import { ObservationSchema, ProfileSchema } from "../src/core/schema";

describe("schema", () => {
  it("accepts a partial interests map and fills defaults", () => {
    const p = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], interests: { kitesurf: 2 } });
    expect(p.interests.kitesurf).toBe(2);
    expect(p.flight.max_stops).toBe(1);
    expect(p.travellers.adults).toBe(1);
  });

  it("parses a flight observation", () => {
    const o = ObservationSchema.parse({
      kind: "flight", id: "f1", title: "VLC → LIS", place: "Lisbon",
      provenance: { source: "kiwi-mcp", seen_at: "2026-10-23T08:00:00+02:00" },
      origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-09",
      price: { amount_minor: 8900, currency: "EUR" }, stops: 0,
    });
    expect(o.kind).toBe("flight");
  });
});
