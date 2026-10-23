import { describe, expect, it } from "vitest";
import { ObservationSchema } from "../src/core/schema";
import { duffel, isoMinutes, mapDuffel, planPairs, requestBody } from "../src/server/sources/duffel";
import { bookUrl, mapTravelpayouts, planRequests, requestUrl, travelpayouts } from "../src/server/sources/travelpayouts";
import { flightId } from "../src/server/sources/id";
import { fakeFetch, fixture, flightsVlcLis, NOW } from "./sources-helpers";

describe("travelpayouts", () => {
  const tp = fixture("travelpayouts-prices-for-dates.json");
  const q = { ...flightsVlcLis, nights: { min: 3, max: 6 } };

  it("maps cached fares, converts to minor units and keeps only the window and the stop limit", () => {
    const obs = mapTravelpayouts(tp, q, NOW, "123456");
    // 2027-01 fare is outside the window; the 10-night fare is outside 3..6 nights; the 1-stop IB fare is outside nights too.
    expect(obs.map((o) => o.kind === "flight" && o.price.amount_minor)).toEqual([5800, 6400]);
    const o = obs[0]!;
    if (o.kind !== "flight") throw new Error();
    expect(o).toMatchObject({ origin: "VLC", destination: "LIS", place: "Lisbon", country: "PT", depart_date: "2026-12-06", return_date: "2026-12-10", stops: 0, seller: "Aviasales" });
    expect(o.price.currency).toBe("EUR");
    expect(o.book_url).toBe("https://www.aviasales.com/search/VLC0612LIS10121?t=FR17650000&marker=123456");
    expect(o.provenance.source).toBe("travelpayouts");
    expect(o.provenance.url).toBe(o.book_url);
    for (const x of obs) expect(() => ObservationSchema.parse(x)).not.toThrow();
  });

  it("sets expires_at 24 h out when the API gives none, and from the API when it does", () => {
    const [first] = mapTravelpayouts(tp, q, NOW);
    expect(first!.provenance.expires_at).toBe("2026-10-24T08:00:00.000Z");
    const any = fixture("travelpayouts-anywhere.json");
    const obs = mapTravelpayouts(any, { ...flightsVlcLis, destination: "anywhere", nights: undefined }, NOW);
    const zzz = obs.find((o) => o.kind === "flight" && o.destination === "ZZZ")!;
    expect(zzz.provenance.expires_at).toBe("2026-10-20T00:00:00+00:00");
    // Already past `NOW`: the ranker will mark it stale.
    expect(Date.parse(zzz.provenance.expires_at!)).toBeLessThan(NOW.getTime());
    // Unknown airport falls back to its code as the place.
    expect(zzz.place).toBe("ZZZ");
  });

  it("drops fares over the stop limit", () => {
    const direct = mapTravelpayouts(tp, { ...flightsVlcLis, nights: undefined, max_stops: 0 }, NOW);
    expect(direct.every((o) => o.kind === "flight" && o.stops === 0)).toBe(true);
  });

  it("builds one request per origin, destination and month, capped", () => {
    const wide = { ...flightsVlcLis, origin: ["VLC", "ALC", "MAD", "BCN"], destination: ["LIS", "OPO", "FAO", "MAD"], window: { from: "2026-12-01", to: "2027-03-01" } };
    expect(planRequests(wide).length).toBe(12);
    expect(travelpayouts.callsFor!(wide)).toBe(12);
    expect(planRequests({ ...flightsVlcLis, window: { from: "2026-12-30", to: "2027-01-03" } }).map((r) => r.month)).toEqual(["2026-12", "2027-01"]);
  });

  it("asks for one fare per destination when going anywhere, with the token in a header", async () => {
    const any = { ...flightsVlcLis, destination: "anywhere" as const };
    const url = new URL(requestUrl(planRequests(any)[0]!, any));
    expect(url.pathname).toBe("/aviasales/v3/prices_for_dates");
    expect(url.searchParams.get("unique")).toBe("true");
    expect(url.searchParams.has("destination")).toBe(false);
    expect(url.search).not.toMatch(/token/);
    const { fetch, seen } = fakeFetch(() => fixture("travelpayouts-anywhere.json"));
    const obs = await travelpayouts.search(any, { now: NOW, fetch, env: { TRAVELPAYOUTS_TOKEN: "secret-token" } });
    expect(obs.length).toBeGreaterThan(0);
    expect(seen[0]!.headers["x-access-token"]).toBe("secret-token");
  });

  it("explains how to enable it", () => {
    expect(travelpayouts.enabled({})).toBe(false);
    expect(travelpayouts.why_disabled({})).toMatch(/TRAVELPAYOUTS_TOKEN/);
    expect(travelpayouts.enabled({ TRAVELPAYOUTS_TOKEN: "x" })).toBe(true);
    expect(travelpayouts.why_disabled({ TRAVELPAYOUTS_TOKEN: "x" })).toBeNull();
  });

  it("builds affiliate links only with a marker", () => {
    expect(bookUrl("/search/A", undefined)).toBe("https://www.aviasales.com/search/A");
    expect(bookUrl(undefined, "1")).toBeUndefined();
  });
});

describe("duffel", () => {
  const res = fixture("duffel-offer-request.json");
  const q = { ...flightsVlcLis, nights: { min: 4, max: 4 } };

  it("maps offers: per-person price, local times with offsets, expiry from the offer", () => {
    const obs = mapDuffel(res, q, NOW);
    expect(obs).toHaveLength(2);
    const [cheap, dear] = obs;
    if (cheap?.kind !== "flight" || dear?.kind !== "flight") throw new Error();
    expect(cheap.price).toEqual({ amount_minor: 16410, currency: "EUR" });
    expect(cheap.stops).toBe(1);
    expect(cheap.place).toBe("Lisbon");
    expect(cheap.country).toBe("PT");
    expect(dear.legs[0]).toMatchObject({ depart_at: "2026-12-05T05:55:00+01:00", arrive_at: "2026-12-05T06:40:00+00:00", flight_no: "TP1097" });
    expect(dear.duration_minutes).toBe(105);
    expect(dear.provenance.expires_at).toBe("2026-10-23T09:30:00Z");
    expect(dear.provenance.url).toBeUndefined();
    expect(dear.seller).toBe("TAP Air Portugal");
    for (const x of obs) expect(() => ObservationSchema.parse(x)).not.toThrow();
  });

  it("is off until the key and the paid flag are both set", () => {
    expect(duffel.paid).toBe(true);
    expect(duffel.enabled({})).toBe(false);
    expect(duffel.enabled({ DUFFEL_TOKEN: "t" })).toBe(false);
    expect(duffel.enabled({ RUMBO_ALLOW_PAID_DUFFEL: "1" })).toBe(false);
    expect(duffel.enabled({ DUFFEL_TOKEN: "t", RUMBO_ALLOW_PAID_DUFFEL: "1" })).toBe(true);
    expect(duffel.why_disabled({})).toMatch(/DUFFEL_TOKEN/);
    expect(duffel.why_disabled({ DUFFEL_TOKEN: "t" })).toMatch(/RUMBO_ALLOW_PAID_DUFFEL=1/);
    expect(duffel.why_disabled({ DUFFEL_TOKEN: "t", RUMBO_ALLOW_PAID_DUFFEL: "1" })).toBeNull();
  });

  it("searches one date per pair, never anywhere, and only ever calls offer_requests", async () => {
    expect(planPairs({ ...q, destination: "anywhere" })).toEqual([]);
    expect(duffel.callsFor!({ ...q, destination: "anywhere" })).toBe(0);
    const body = requestBody(q, { origin: "VLC", destination: "LIS" }, "2026-10-23");
    expect(body.data.slices).toEqual([
      { origin: "VLC", destination: "LIS", departure_date: "2026-12-04" },
      { origin: "LIS", destination: "VLC", departure_date: "2026-12-08" },
    ]);
    const { fetch, seen } = fakeFetch(() => res);
    await duffel.search(q, { now: NOW, fetch, env: { DUFFEL_TOKEN: "tok", RUMBO_ALLOW_PAID_DUFFEL: "1" } });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe("/air/offer_requests");
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(seen[0]!.headers["duffel-version"]).toBe("v2");
    expect(seen.some((s) => /orders/.test(s.url))).toBe(false);
  });

  it("sends children by age, defaulting to 8", () => {
    const withKids = requestBody({ ...q, adults: 2, children: 2, child_ages: [4] }, { origin: "VLC", destination: "LIS" }, "2026-10-23");
    expect(withKids.data.passengers).toEqual([{ type: "adult" }, { type: "adult" }, { age: 4 }, { age: 8 }]);
    expect(requestBody(q, { origin: "VLC", destination: "LIS" }, "2026-10-23").data.passengers.every((p: any) => p.type === "adult")).toBe(true);
  });

  it("parses ISO durations", () => {
    expect(isoMinutes("PT02H26M")).toBe(146);
    expect(isoMinutes("PT45M")).toBe(45);
    expect(isoMinutes(null)).toBeUndefined();
  });
});

describe("flight ids", () => {
  const base = { origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-10" };
  it("are the same for the same itinerary from two sources and ignore the price", () => {
    const k = flightId({ ...base, legs: ["TP1097@2026-12-06", "TP1098@2026-12-10"] });
    const t = flightId({ ...base, origin: "vlc", legs: ["TP1097@2026-12-06", "TP1098@2026-12-10"] });
    expect(k).toBe(t);
    expect(k).toMatch(/^fli_[0-9a-f]{24}$/);
    expect(flightId({ ...base, depart_date: "2026-12-07", legs: ["TP1097@2026-12-07", "TP1098@2026-12-10"] })).not.toBe(k);
  });

  it("differ when only the return flight or an onward connection differs", () => {
    const out = "TP1097@2026-12-06";
    const a = flightId({ ...base, legs: [out, "TP1098@2026-12-10"] });
    const b = flightId({ ...base, legs: [out, "TP1100@2026-12-10"] });
    const c = flightId({ ...base, legs: [out, "IB123@2026-12-06", "TP1098@2026-12-10"] });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("keep letters of every script", () => {
    const ids = ["東京", "Москва", "القاهرة", "Zürich"].map((destination) => flightId({ ...base, destination }));
    expect(new Set(ids).size).toBe(4);
    expect(flightId({ ...base, destination: "Ｚürich" })).toBe(flightId({ ...base, destination: "zürich" })); // NFKC folds full-width letters
  });
});
