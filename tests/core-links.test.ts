import { describe, expect, it } from "vitest";
import {
  AIRLINES, airbnbLink, airlineLink, airlineLinks, bookingLink, discoverCarsLink, findAirline, getYourGuideLink,
  googleFlightsLink, googleHotelsLink, googleMapsLink, kayakLink, kiwiLink, linksForPlan, q, rentalcarsLink,
  skyscannerLink, slug, viatorLink,
} from "../src/core/links";

const trip = { from: "VLC", to: "LIS", depart: "2026-12-06", return: "2026-12-09" };
const stay = { place: "Lisbon", checkIn: "2026-12-06", checkOut: "2026-12-09", adults: 2 };

describe("flight aggregators (formats shared with Loco)", () => {
  it("builds the Google Flights q= sentence", () => {
    expect(googleFlightsLink(trip).url).toBe("https://www.google.com/travel/flights?q=Flights%20from%20VLC%20to%20LIS%20on%202026-12-06%20through%202026-12-09");
    expect(googleFlightsLink({ ...trip, adults: 2 }).url).toContain("for%202%20adults");
    expect(googleFlightsLink({ from: "vlc", to: "lis", depart: "2026-12-06" }).url).toBe("https://www.google.com/travel/flights?q=Flights%20from%20VLC%20to%20LIS%20on%202026-12-06");
  });

  it("builds Skyscanner and Kayak paths", () => {
    expect(skyscannerLink(trip).url).toBe("https://www.skyscanner.net/transport/flights/vlc/lis/261206/261209/?adults=1");
    expect(skyscannerLink({ ...trip, return: undefined, adults: 2, children: 1 }).url).toBe("https://www.skyscanner.net/transport/flights/vlc/lis/261206/?adults=2&children=1");
    expect(kayakLink(trip).url).toBe("https://www.kayak.com/flights/VLC-LIS/2026-12-06/2026-12-09?sort=bestflight_a");
    expect(kayakLink({ ...trip, return: undefined }).url).toBe("https://www.kayak.com/flights/VLC-LIS/2026-12-06?sort=bestflight_a");
  });

  it("builds Kiwi with city slugs when given, else IATA codes", () => {
    expect(kiwiLink({ ...trip, fromSlug: "valencia-spain", toSlug: "lisbon-portugal" }).url).toBe("https://www.kiwi.com/en/search/results/valencia-spain/lisbon-portugal/2026-12-06/2026-12-09");
    expect(kiwiLink(trip).url).toBe("https://www.kiwi.com/en/search/results/vlc/lis/2026-12-06/2026-12-09");
    expect(kiwiLink({ ...trip, return: undefined }).url).toContain("/2026-12-06/no-return");
  });
});

describe("airlines", () => {
  it("covers the carriers that matter from VLC, ALC, MAD and BCN", () => {
    const names = AIRLINES.map((a) => a.name);
    for (const n of ["Ryanair", "Vueling", "Iberia", "Iberia Express", "Air Europa", "easyJet", "Volotea", "Wizz Air", "Transavia", "TAP Air Portugal", "Binter", "Lufthansa", "KLM", "Air France", "ITA Airways", "Turkish Airlines", "Emirates", "Qatar Airways"]) {
      expect(names, n).toContain(n);
    }
  });

  it("deep-links Ryanair with route and dates, one-way and return", () => {
    const u = new URL(airlineLink("Ryanair", trip)!.url);
    expect(u.origin + u.pathname).toBe("https://www.ryanair.com/gb/en/trip/flights/select");
    expect(u.searchParams.get("originIata")).toBe("VLC");
    expect(u.searchParams.get("destinationIata")).toBe("LIS");
    expect(u.searchParams.get("dateOut")).toBe("2026-12-06");
    expect(u.searchParams.get("dateIn")).toBe("2026-12-09");
    expect(u.searchParams.get("isReturn")).toBe("true");
    const one = new URL(airlineLink("Ryanair", { ...trip, return: undefined })!.url);
    expect(one.searchParams.get("isReturn")).toBe("false");
    expect(one.searchParams.has("dateIn")).toBe(false);
  });

  it("deep-links easyJet in dd-mm-yyyy and falls back to the booking home page elsewhere", () => {
    const u = new URL(airlineLink("easyJet", trip)!.url);
    expect(u.searchParams.get("dd")).toBe("06-12-2026");
    expect(u.searchParams.get("rd")).toBe("09-12-2026");
    expect(airlineLink("Vueling", trip)).toEqual({ label: "Vueling (booking site)", url: "https://www.vueling.com/en" });
  });

  it("finds a carrier by name, code or prefix", () => {
    expect(findAirline("VY")?.name).toBe("Vueling");
    expect(findAirline("tap")?.name).toBe("TAP Air Portugal");
    expect(findAirline("Turkish")?.name).toBe("Turkish Airlines");
    expect(findAirline("Iberia")?.name).toBe("Iberia");
    expect(findAirline("Iberia Express")?.code).toBe("I2");
    expect(findAirline("Nope Air")).toBeUndefined();
    expect(airlineLink("Nope Air", trip)).toBeNull();
  });

  it("lists default carriers, or the ones asked for, without duplicates", () => {
    expect(airlineLinks(trip).map((l) => l.label.split(" (")[0])).toEqual(["Ryanair", "Vueling", "Iberia", "easyJet", "Volotea", "Air Europa"]);
    expect(airlineLinks(trip, ["FR", "Ryanair", "Binter", "Unknown"])).toHaveLength(2);
  });
});

describe("stays", () => {
  it("builds Booking.com with dates, adults, rooms and children", () => {
    const u = new URL(bookingLink({ ...stay, rooms: 2, children: 1 }).url);
    expect(u.origin + u.pathname).toBe("https://www.booking.com/searchresults.html");
    expect(u.searchParams.get("ss")).toBe("Lisbon");
    expect(u.searchParams.get("checkin")).toBe("2026-12-06");
    expect(u.searchParams.get("checkout")).toBe("2026-12-09");
    expect(u.searchParams.get("group_adults")).toBe("2");
    expect(u.searchParams.get("no_rooms")).toBe("2");
    expect(u.searchParams.get("group_children")).toBe("1");
    expect(new URL(bookingLink(stay).url).searchParams.get("no_rooms")).toBe("1");
  });

  it("builds Airbnb and Google Hotels", () => {
    expect(airbnbLink(stay).url).toBe("https://www.airbnb.com/s/Lisbon/homes?checkin=2026-12-06&checkout=2026-12-09&adults=2");
    expect(googleHotelsLink(stay).url).toBe("https://www.google.com/travel/search?q=Lisbon&checkin=2026-12-06&checkout=2026-12-09&adults=2");
  });

  it("encodes places like Loco does (apostrophes, accents, commas)", () => {
    expect(q("L'Hospitalet")).toBe("L%27Hospitalet");
    expect(q("Alfama, Lisbon")).toBe("Alfama,%20Lisbon");
    expect(airbnbLink({ ...stay, place: "São Paulo" }).url).toContain("/s/S%C3%A3o%20Paulo/homes");
    expect(slug("São Paulo")).toBe("sao-paulo");
  });
});

describe("cars and things to do", () => {
  it("links Discover Cars by country and city, Rentalcars to its home page", () => {
    expect(discoverCarsLink({ place: "Málaga", country: "Spain", pickup: "2026-12-06", dropoff: "2026-12-09" }).url).toBe("https://www.discovercars.com/spain/malaga");
    expect(discoverCarsLink({ place: "Málaga", pickup: "2026-12-06", dropoff: "2026-12-09" }).url).toBe("https://www.discovercars.com/");
    expect(rentalcarsLink({ place: "Málaga", pickup: "2026-12-06", dropoff: "2026-12-09" }).url).toBe("https://www.rentalcars.com/");
  });

  it("builds Maps, GetYourGuide and Viator searches", () => {
    expect(googleMapsLink("Lisbon").url).toBe("https://www.google.com/maps/search/?api=1&query=Lisbon");
    expect(googleMapsLink("Praça do Comércio, Lisbon").url).toContain("query=Pra%C3%A7a%20do%20Com%C3%A9rcio%2C%20Lisbon");
    expect(getYourGuideLink("Lisbon", { from: "2026-12-06", to: "2026-12-09" }).url).toBe("https://www.getyourguide.com/s/?q=Lisbon&date_from=2026-12-06&date_to=2026-12-09");
    expect(viatorLink("Lisbon").url).toBe("https://www.viator.com/searchResults/all?text=Lisbon");
  });
});

describe("linksForPlan", () => {
  const input = { place: "Lisbon", country: "Portugal", airports: ["LIS"], origins: ["VLC", "MAD"], dates: { from: "2026-12-06", to: "2026-12-09" }, adults: 2, originSlug: "valencia-spain" };

  it("covers flights, stay, car and activities, every url absolute https", () => {
    const links = linksForPlan(input);
    expect(new Set(links.map((l) => l.section))).toEqual(new Set(["flights", "stay", "car", "activities"]));
    for (const l of links) {
      expect(l.url).toMatch(/^https:\/\//);
      expect(() => new URL(l.url)).not.toThrow();
      expect(l.label.length).toBeGreaterThan(0);
    }
    expect(links.find((l) => l.label.startsWith("Kiwi"))!.url).toContain("/valencia-spain/lisbon-portugal/2026-12-06/2026-12-09");
    expect(links.filter((l) => l.label.startsWith("Google Flights")).map((l) => l.label)).toEqual(["Google Flights VLC–LIS", "Google Flights MAD–LIS"]);
    expect(links.some((l) => l.label.startsWith("Ryanair"))).toBe(true);
    expect(links.find((l) => l.label.startsWith("Booking.com"))!.url).toContain("group_adults=2");
  });

  it("only returns the sections that were asked for", () => {
    const only = linksForPlan({ ...input, needs: ["stay"] });
    expect(new Set(only.map((l) => l.section))).toEqual(new Set(["stay"]));
    expect(linksForPlan({ ...input, needs: ["events"] })).toEqual([]);
  });

  it("narrows the airlines to the carriers given", () => {
    const links = linksForPlan({ ...input, needs: ["flights"], carriers: ["TAP", "Binter"] });
    const airlines = links.filter((l) => /TAP|Binter/.test(l.label));
    expect(airlines).toHaveLength(2);
    expect(links.some((l) => l.label.startsWith("Ryanair"))).toBe(false);
  });
});
