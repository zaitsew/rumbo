import { describe, expect, it } from "vitest";
import { ObservationSchema } from "../src/core/schema";
import { liteapi, createLiteapiSource, mapLiteapi } from "../src/server/sources/liteapi";
import { mapTicketmaster, requestUrl as tmUrl, ticketmaster } from "../src/server/sources/ticketmaster";
import { mapTiqets, minutesOf, requestUrl as tqUrl, tiqets } from "../src/server/sources/tiqets";
import { createViatorSource, mapViator, pickDestination } from "../src/server/sources/viator";
import { fakeFetch, fixture, NOW } from "./sources-helpers";

const events = { kind: "events" as const, place: "Valencia", country: "ES", window: { from: "2026-12-01", to: "2026-12-31" } };
const acts = { kind: "activities" as const, place: "Valencia", country: "ES", currency: "EUR" };
const stays = { kind: "stays" as const, place: "Lisbon", check_in: "2026-12-05", check_out: "2026-12-09", adults: 2, currency: "EUR" };

describe("ticketmaster", () => {
  const res = fixture("ticketmaster-events.json");
  const obs = mapTicketmaster(res, events, NOW);

  it("maps events, skips cancelled ones, tags from classifications", () => {
    expect(obs.map((o) => o.title)).toEqual([
      "Café Tacvba - Live in Valencia", "Valencia Basket vs Real Madrid", "Ballet Nacional: El Lago de los Cisnes", "Winter Beats Festival 2026",
    ]);
    expect(obs.map((o) => o.tags)).toEqual([["concerts"], ["sport-events"], ["culture"], ["concerts", "festivals"]]);
    for (const o of obs) expect(() => ObservationSchema.parse(o)).not.toThrow();
  });

  it("fills date, venue, price and provenance", () => {
    const o = obs[0]!;
    if (o.kind !== "event") throw new Error();
    expect(o).toMatchObject({ date: "2026-12-12", venue: "Roig Arena", place: "Valencia", country: "ES", price_from: { amount_minor: 3850, currency: "EUR" } });
    expect(o.provenance).toMatchObject({ source: "ticketmaster", url: o.book_url, seen_at: NOW.toISOString(), expires_at: "2026-12-12T19:00:00Z" });
    const ballet = obs[2]!;
    if (ballet.kind !== "event") throw new Error();
    expect(ballet.end_date).toBe("2026-12-29");
    expect(ballet.provenance.expires_at).toBe("2026-12-29T23:59:59Z");
    expect(obs[1]!.kind === "event" && obs[1]!.price_from).toBeUndefined();
  });

  it("builds the documented query and never leaks the key into errors", async () => {
    const u = new URL(tmUrl(events, "KEY123"));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ apikey: "KEY123", city: "Valencia", countryCode: "ES", startDateTime: "2026-12-01T00:00:00Z", endDateTime: "2026-12-31T23:59:59Z" });
    const { fetch } = fakeFetch(() => ({ status: 401, body: { fault: { faultstring: "Invalid ApiKey" } } }));
    const err = await ticketmaster.search(events, { now: NOW, fetch, env: { TICKETMASTER_API_KEY: "KEY123" } }).catch((e) => e);
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain("KEY123");
  });

  it("has a 1000 call cap and names the env var", () => {
    expect(ticketmaster.dailyCap).toBe(1000);
    expect(ticketmaster.why_disabled({})).toMatch(/TICKETMASTER_API_KEY/);
    expect(ticketmaster.enabled({ TICKETMASTER_API_KEY: "k" })).toBe(true);
  });

  it("gives a stable id regardless of price or url", () => {
    const again = mapTicketmaster(structuredClone(res), events, new Date(NOW.getTime() + 86_400_000));
    expect(again.map((o) => o.id)).toEqual(obs.map((o) => o.id));
  });
});

describe("viator", () => {
  const dests = fixture("viator-destinations.json");
  const search = fixture("viator-products-search.json");

  it("prefers a CITY destination of that name", () => {
    expect(pickDestination(dests.destinations, "valencia")?.destinationId).toBe(50);
    expect(pickDestination(dests.destinations, "Nowhere")).toBeUndefined();
  });

  it("maps products to activities", () => {
    const obs = mapViator(search, acts, "EUR", NOW);
    expect(obs).toHaveLength(3);
    const [paella, boat, walk] = obs;
    if (paella?.kind !== "activity" || boat?.kind !== "activity" || walk?.kind !== "activity") throw new Error();
    expect(paella).toMatchObject({ title: "Valencia Paella Cooking Class with Market Visit", place: "Valencia", price: { amount_minor: 5900, currency: "EUR" }, duration_minutes: 180, rating: 4.8 });
    expect(paella.book_url).toContain("viator.com/tours/Valencia");
    expect(paella.provenance).toMatchObject({ source: "viator", seen_at: NOW.toISOString(), expires_at: "2026-10-24T08:00:00.000Z" });
    expect(boat.duration_minutes).toBe(60);
    expect(walk.rating).toBeUndefined();
    for (const o of obs) expect(() => ObservationSchema.parse(o)).not.toThrow();
  });

  it("resolves the destination once, caches it, and charges 2 calls then 1", async () => {
    const v = createViatorSource();
    expect(v.callsFor!(acts)).toBe(2);
    const { fetch, seen } = fakeFetch((r) => (r.url.endsWith("/destinations") ? dests : search));
    const ctx = { now: NOW, fetch, env: { VIATOR_API_KEY: "vk" } };
    const obs = await v.search({ ...acts, date: "2026-12-12" }, ctx);
    expect(obs.length).toBe(3);
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["GET /partner/destinations", "POST /partner/products/search"]);
    expect(seen[1]!.headers["exp-api-key"]).toBe("vk");
    expect(seen[1]!.headers.accept).toBe("application/json;version=2.0");
    expect(seen[1]!.body).toMatchObject({ filtering: { destination: "50", startDate: "2026-12-12", endDate: "2026-12-12" }, currency: "EUR" });
    expect(v.callsFor!(acts)).toBe(1);
    await v.search(acts, ctx);
    expect(seen).toHaveLength(3); // no second /destinations
    expect(await v.search({ ...acts, place: "Nowhere" }, ctx)).toEqual([]);
  });

  it("names its env var", () => {
    expect(createViatorSource().why_disabled({})).toMatch(/VIATOR_API_KEY/);
  });
});

describe("tiqets", () => {
  const res = fixture("tiqets-products.json");
  it("maps available products and skips unavailable ones", () => {
    const obs = mapTiqets(res, acts, NOW);
    expect(obs.map((o) => o.title)).toEqual(["Oceanogràfic Valencia Entry Ticket", "City of Arts and Sciences: Hemisfèric"]);
    const o = obs[0]!;
    if (o.kind !== "activity") throw new Error();
    expect(o).toMatchObject({ place: "Valencia", country: "Spain", price: { amount_minor: 3690, currency: "EUR" }, duration_minutes: 240, rating: 4.4 });
    expect(o.book_url).toContain("tiqets.com");
    expect(o.provenance.expires_at).toBe("2026-10-24T08:00:00.000Z");
    for (const x of obs) expect(() => ObservationSchema.parse(x)).not.toThrow();
  });
  it("sends the Token header and the documented parameters", async () => {
    const u = new URL(tqUrl(acts));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ city_name: "Valencia", currency: "EUR", sort: "popularity", page_size: "20" });
    const { fetch, seen } = fakeFetch(() => res);
    await tiqets.search(acts, { now: NOW, fetch, env: { TIQETS_API_KEY: "tq" } });
    expect(seen[0]!.headers.authorization).toBe("Token tq");
    expect(tiqets.why_disabled({})).toMatch(/TIQETS_API_KEY/);
  });
  it("parses HH:MM:SS", () => {
    expect(minutesOf("02:30:00")).toBe(150);
    expect(minutesOf(null)).toBeUndefined();
  });
});

describe("liteapi", () => {
  const hotels = fixture("liteapi-hotels.json");
  const rates = fixture("liteapi-min-rates.json");

  it("maps min rates to stays, cheapest first, joined to hotel names", () => {
    const obs = mapLiteapi(hotels, rates, stays, NOW);
    expect(obs.map((o) => o.kind === "stay" && o.name)).toEqual(["Pensão Alfama", "Eurostars Das Artes", "Hotel Lisboa Plaza"]);
    const o = obs[0]!;
    if (o.kind !== "stay") throw new Error();
    expect(o).toMatchObject({ place: "Lisbon", check_in: "2026-12-05", check_out: "2026-12-09", price_total: { amount_minor: 19800, currency: "EUR" }, rating: 7.9, stay_kind: "hotel" });
    expect(obs[1]!.kind === "stay" && obs[1]!.rating).toBeUndefined(); // rating 0 means unrated
    for (const x of obs) expect(() => ObservationSchema.parse(x)).not.toThrow();
  });

  it("needs both the key and the paid flag, and says which is missing", () => {
    expect(liteapi.paid).toBe(true);
    expect(liteapi.enabled({ LITEAPI_KEY: "k" })).toBe(false);
    expect(liteapi.enabled({ RUMBO_ALLOW_PAID_LITEAPI: "1" })).toBe(false);
    expect(liteapi.enabled({ LITEAPI_KEY: "k", RUMBO_ALLOW_PAID_LITEAPI: "1" })).toBe(true);
    expect(liteapi.why_disabled({})).toMatch(/LITEAPI_KEY/);
    expect(liteapi.why_disabled({ LITEAPI_KEY: "k" })).toMatch(/RUMBO_ALLOW_PAID_LITEAPI=1/);
    expect(liteapi.why_disabled({ LITEAPI_KEY: "k", RUMBO_ALLOW_PAID_LITEAPI: "1" })).toBeNull();
  });

  it("lists hotels once per city, then asks for min rates", async () => {
    const l = createLiteapiSource();
    expect(l.callsFor!(stays)).toBe(2);
    const { fetch, seen } = fakeFetch((r) => (r.url.includes("/data/hotels") ? hotels : rates));
    const ctx = { now: NOW, fetch, env: { LITEAPI_KEY: "lk", RUMBO_ALLOW_PAID_LITEAPI: "1" } };
    await l.search(stays, ctx);
    const [list, min] = seen;
    expect(new URL(list!.url).searchParams.get("cityName")).toBe("Lisbon");
    expect(new URL(list!.url).searchParams.get("countryCode")).toBe("PT");
    expect(list!.headers["x-api-key"]).toBe("lk");
    expect(min!.body).toMatchObject({ checkin: "2026-12-05", checkout: "2026-12-09", currency: "EUR", occupancies: [{ adults: 2 }], hotelIds: ["lp19f3a", "lp2b7c1", "lp3d9e5", "lp4aaaa"] });
    expect(l.callsFor!(stays)).toBe(1);
    await l.search(stays, ctx);
    expect(seen).toHaveLength(3);
  });
});
