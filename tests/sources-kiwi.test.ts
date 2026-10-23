import { describe, expect, it } from "vitest";
import { ObservationSchema } from "../src/core/schema";
import { KIWI_TOOL, createKiwiSource, kiwiArguments, mapKiwi, parseKiwiResult } from "../src/server/sources/kiwi";
import { fixture, flightsVlcLis, NOW } from "./sources-helpers";

const recorded = fixture("kiwi-search-flight.json");
const tools = fixture("kiwi-tools.json");

describe("kiwi tool listing", () => {
  it("is the real listing and the adapter targets its tool and required arguments", () => {
    const tool = tools.tools.find((t: any) => t.name === KIWI_TOOL);
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.required).toEqual(["flyFrom", "flyTo", "departureDate"]);
    const args = kiwiArguments(flightsVlcLis, NOW);
    for (const k of Object.keys(args)) expect(Object.keys(tool.inputSchema.properties)).toContain(k);
  });
});

describe("kiwiArguments", () => {
  it("formats dates as dd/mm/yyyy and turns nights into a return search", () => {
    const a = kiwiArguments(flightsVlcLis, NOW);
    expect(a).toMatchObject({ flyFrom: "VLC", flyTo: "LIS", departureDate: "04/12/2026", departureDateTo: "06/12/2026", nights_in_dst_from: 3, nights_in_dst_to: 4, max_sector_stopovers: 1, currency: "EUR" });
  });
  it("joins several airports and asks for one result per city when going anywhere", () => {
    const a = kiwiArguments({ ...flightsVlcLis, origin: ["VLC", "ALC"], destination: "anywhere", nights: undefined }, NOW);
    expect(a).toMatchObject({ flyFrom: "VLC,ALC", flyTo: "anywhere", one_for_city: true });
    expect(a).not.toHaveProperty("nights_in_dst_from");
  });
  it("passes children to Kiwi", () => {
    const a = kiwiArguments({ ...flightsVlcLis, adults: 2, children: 2, child_ages: [5, 8] }, NOW);
    expect(a).toMatchObject({ adults: 2, children: 2 });
    expect(Object.keys(tools.tools.find((t: any) => t.name === KIWI_TOOL).inputSchema.properties)).toContain("children");
    // Kiwi counts children aged 2-11 only; a 12-year-old is an adult fare it cannot express here.
    expect(kiwiArguments({ ...flightsVlcLis, children: 2, child_ages: [1, 8] }, NOW)).toMatchObject({ children: 1 });
    expect(kiwiArguments(flightsVlcLis, NOW)).not.toHaveProperty("children");
  });
  it("never searches the past", () => {
    const a = kiwiArguments({ ...flightsVlcLis, window: { from: "2026-10-01", to: "2026-10-02" } }, NOW);
    expect(a.departureDate).toBe("23/10/2026");
  });
});

describe("mapKiwi on the recorded response", () => {
  const raw = { structuredContent: recorded.structuredContent };
  const obs = mapKiwi(parseKiwiResult(raw), flightsVlcLis, NOW);

  it("maps to valid observations with full provenance", () => {
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(() => ObservationSchema.parse(o)).not.toThrow();
      expect(o.kind).toBe("flight");
      expect(o.provenance.source).toBe("kiwi-mcp");
      expect(o.provenance.url).toMatch(/^https:\/\/kiwi\.com\/u\//);
      expect(o.provenance.seen_at).toBe(NOW.toISOString());
      expect(Date.parse(o.provenance.expires_at!)).toBeGreaterThan(NOW.getTime());
      expect(o.book_url).toBe(o.provenance.url);
    }
  });

  it("converts price to minor units and fills place, legs and offsets", () => {
    const first = obs.find((o) => o.kind === "flight" && o.price.amount_minor === 9000)!;
    expect(first).toBeTruthy();
    if (first.kind !== "flight") throw new Error();
    expect(first.price).toEqual({ amount_minor: 9000, currency: "EUR" });
    expect(first.origin).toBe("VLC");
    expect(first.destination).toBe("LIS");
    expect(first.place).toBe("Lisbon");
    expect(first.country).toBe("Portugal");
    expect(first.depart_date).toBe("2026-12-06");
    expect(first.return_date).toBe("2026-12-10");
    expect(first.stops).toBe(0);
    expect(first.duration_minutes).toBe(105);
    // VLC is UTC+1 in December, LIS is UTC+0.
    expect(first.legs[0]).toMatchObject({ from: "VLC", to: "LIS", depart_at: "2026-12-06T05:55:00+01:00", arrive_at: "2026-12-06T06:40:00+00:00", flight_no: "TP1097", carrier: "TAP Portugal" });
    expect(first.legs[1]).toMatchObject({ from: "LIS", to: "VLC", depart_at: "2026-12-10T21:15:00+00:00", arrive_at: "2026-12-10T23:50:00+01:00" });
  });

  it("divides a multi-passenger price into a price per person", () => {
    const two = { ...recorded.structuredContent, passengers: { adults: 2, children: 0, infants: 0 } };
    const o = mapKiwi(two, { ...flightsVlcLis, adults: 2 }, NOW).find((x) => x.kind === "flight")!;
    if (o.kind !== "flight") throw new Error();
    expect(o.price.amount_minor).toBe(4500);
  });

  it("leaves legs out, instead of guessing, when an airport's zone is unknown", () => {
    const odd = structuredClone(recorded.structuredContent);
    for (const it of odd.itineraries) for (const sg of it.outbound.segments) { sg.to = "XXX"; sg.toCountry = "Narnia"; }
    const mapped = mapKiwi(parseKiwiResult({ structuredContent: odd }), flightsVlcLis, NOW);
    expect(mapped.length).toBeGreaterThan(0);
    for (const o of mapped) {
      if (o.kind !== "flight") throw new Error();
      expect(o.legs).toEqual([]);
      expect(o.depart_date).toBeTruthy();
      expect(o.price.amount_minor).toBeGreaterThan(0);
    }
  });

  it("ids cover the return flight: same outbound with another return is another itinerary", () => {
    const c = structuredClone(recorded.structuredContent);
    const src = c.itineraries.find((i: any) => i.inbound?.segments?.length);
    if (!src) throw new Error("fixture has no return itinerary");
    const twin = structuredClone(src);
    twin.inbound.segments[0].flightNumber = "9999";
    c.itineraries = [src, twin];
    const mapped = mapKiwi(parseKiwiResult({ structuredContent: c }), flightsVlcLis, NOW);
    expect(new Set(mapped.map((o) => o.id)).size).toBe(2);
  });

  it("keeps ids stable between runs and ignores the price", () => {
    const again = mapKiwi(parseKiwiResult(raw), flightsVlcLis, new Date(NOW.getTime() + 3600_000));
    expect(again.map((o) => o.id)).toEqual(obs.map((o) => o.id));
    const cheaper = structuredClone(recorded.structuredContent);
    cheaper.itineraries[0].price = 70;
    const third = mapKiwi(cheaper, flightsVlcLis, NOW);
    expect(third[0]!.id).toBe(obs[0]!.id);
  });

  it("has unique ids", () => {
    expect(new Set(obs.map((o) => o.id)).size).toBe(obs.length);
  });
});

describe("kiwi failures and switch", () => {
  it("raises the tool's error text", () => {
    expect(() => mapKiwi({ error: "Invalid date" }, flightsVlcLis, NOW)).toThrow(/Invalid date/);
  });
  it("reads the JSON text block when structuredContent is missing", () => {
    const r = parseKiwiResult({ content: [{ type: "text", text: JSON.stringify(recorded.structuredContent) }] });
    expect(r.itineraries?.length).toBeGreaterThan(0);
  });
  it("reports a plain-text failure", () => {
    expect(() => parseKiwiResult({ content: [{ type: "text", text: "rate limited" }] })).toThrow(/rate limited/);
  });
  it("is on by default and off with RUMBO_KIWI_MCP=0", () => {
    const s = createKiwiSource(async () => ({}));
    expect(s.enabled({})).toBe(true);
    expect(s.why_disabled({})).toBeNull();
    expect(s.enabled({ RUMBO_KIWI_MCP: "0" })).toBe(false);
    expect(s.why_disabled({ RUMBO_KIWI_MCP: "0" })).toMatch(/RUMBO_KIWI_MCP/);
    expect(s.paid).toBe(false);
    expect(s.dailyCap).toBe(60);
  });
  it("search calls the injected tool once and ignores other query kinds", async () => {
    let calls = 0;
    const s = createKiwiSource(async () => { calls++; return { structuredContent: recorded.structuredContent }; });
    expect((await s.search(flightsVlcLis, { now: NOW })).length).toBeGreaterThan(0);
    expect(await s.search({ kind: "events", place: "Lisbon", window: { from: "2026-12-01", to: "2026-12-02" } }, { now: NOW })).toEqual([]);
    expect(calls).toBe(1);
  });
});
