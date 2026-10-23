/**
 * Deep links: pure builders that return `{label, url}`. Nothing here calls a site (D2: no scraping);
 * the owner opens the link and sees the aggregator's or airline's own page, pre-filled where the site
 * allows it.
 *
 * Formats for Google Flights, Skyscanner, Kayak, Booking.com, Airbnb and Google Hotels are the ones
 * Loco already ships and tests (loco/packages/mcp/src/links.ts, held to its links-conformance file).
 *
 * Verification, 2026-10-23: one `curl -s -o /dev/null -w "%{http_code}" -L` per site, no content read.
 * A 200 says the host answers that path; it does not prove the page pre-fills the query. A 403 or 405
 * is the site refusing curl, not a broken format.
 *   200  Google Flights, Skyscanner, Kayak, Kiwi, Google Hotels, Airbnb, Google Maps, Discover Cars,
 *        Rentalcars, Ryanair (deep link), Iberia, Iberia Express, Air Europa, Volotea, TAP
 *   202  Booking.com search results
 *   403  GetYourGuide, Viator, easyJet (deep link), Vueling, Transavia, Binter, Lufthansa, Emirates, ITA
 *   405  Wizz Air
 *   no answer from this machine (not checked): KLM, Air France, Turkish, Qatar
 * Unverified guesses are marked `best-effort` beside the builder. Prefer the owner's eyes on the first
 * click over a claim that a format works.
 */

export interface Link { label: string; url: string }
export type PlanSection = "flights" | "stay" | "car" | "activities";
export interface SectionLink extends Link { section: PlanSection }

export interface FlightSearch {
  from: string; // IATA
  to: string; // IATA
  depart: string; // YYYY-MM-DD
  return?: string;
  adults?: number;
  children?: number;
  /** "valencia-spain": Kiwi's city slugs. Without them the Kiwi link uses the IATA codes (best-effort). */
  fromSlug?: string;
  toSlug?: string;
}

export interface StaySearch {
  place: string; // "Lisbon", or "Alfama, Lisbon"
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
}

export interface CarSearch {
  place: string;
  country?: string;
  pickup: string; // YYYY-MM-DD
  dropoff: string;
  /** IATA code when the pick-up is an airport. */
  airport?: string;
}

// --- encoding (byte for byte with Loco's `q()`) ----------------------------------------------------

/** encodeURIComponent plus `!'()*`, with a literal comma kept for readability. */
export function q(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2C/g, ",");
}

const yymmdd = (day: string): string => day.slice(2).replace(/-/g, "");
const ddmmyyyy = (day: string): string => day.split("-").reverse().join("-");
const adultsOf = (i: { adults?: number }): number => Math.max(1, i.adults ?? 1);
const childrenOf = (i: { children?: number }): number => Math.max(0, i.children ?? 0);

/** "São Paulo" -> "sao-paulo". */
export function slug(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// --- flights: aggregators -------------------------------------------------------------------------

/** Google Flights parses the q= sentence (Loco's form, plus the party when it is more than one adult). */
export function googleFlightsLink(i: FlightSearch): Link {
  const from = i.from.toUpperCase();
  const to = i.to.toUpperCase();
  let text = `Flights from ${from} to ${to} on ${i.depart}`;
  if (i.return) text += ` through ${i.return}`;
  if (adultsOf(i) > 1) text += ` for ${adultsOf(i)} adults`;
  return { label: `Google Flights ${from}–${to}`, url: `https://www.google.com/travel/flights?q=${q(text)}` };
}

export function skyscannerLink(i: FlightSearch): Link {
  const from = i.from.toLowerCase();
  const to = i.to.toLowerCase();
  const path = `${from}/${to}/${yymmdd(i.depart)}/${i.return ? yymmdd(i.return) + "/" : ""}`;
  // `adults` and `children` are query keys Skyscanner has long read; best-effort.
  const qs = `?adults=${adultsOf(i)}${childrenOf(i) ? `&children=${childrenOf(i)}` : ""}`;
  return { label: `Skyscanner ${i.from.toUpperCase()}–${i.to.toUpperCase()}`, url: `https://www.skyscanner.net/transport/flights/${path}${qs}` };
}

export function kayakLink(i: FlightSearch): Link {
  const from = i.from.toUpperCase();
  const to = i.to.toUpperCase();
  // Loco's form. Kayak's party path segment is not verified, so the party is not encoded (Kayak asks).
  return { label: `Kayak ${from}–${to}`, url: `https://www.kayak.com/flights/${from}-${to}/${i.depart}${i.return ? "/" + i.return : ""}?sort=bestflight_a` };
}

/**
 * Kiwi.com: /en/search/results/<from>/<to>/<depart>/<return>. The path takes city slugs
 * ("valencia-spain"). With no slugs the IATA codes go in the same positions (best-effort: unverified).
 */
export function kiwiLink(i: FlightSearch): Link {
  const from = i.fromSlug ?? i.from.toLowerCase();
  const to = i.toSlug ?? i.to.toLowerCase();
  const dates = `${i.depart}/${i.return ?? "no-return"}`;
  const qs = adultsOf(i) > 1 || childrenOf(i) ? `?adults=${adultsOf(i)}&children=${childrenOf(i)}` : "";
  return { label: `Kiwi.com ${i.from.toUpperCase()}–${i.to.toUpperCase()}`, url: `https://www.kiwi.com/en/search/results/${from}/${to}/${dates}${qs}` };
}

// --- flights: airlines' own sites -----------------------------------------------------------------

interface Airline {
  name: string;
  code: string; // IATA designator
  home: string;
  /** A deep link with route and dates, only where the site is known to take one. */
  deep?: (i: FlightSearch) => string;
}

/** Ryanair's trip/flights/select URL (verified to answer 200). */
function ryanairDeep(i: FlightSearch): string {
  const a = adultsOf(i);
  const c = childrenOf(i);
  const ret = !!i.return;
  const p = new URLSearchParams({
    adults: String(a), teens: "0", children: String(c), infants: "0",
    dateOut: i.depart, ...(ret ? { dateIn: i.return! } : {}),
    isConnectedFlight: "false", isReturn: String(ret), discount: "0", promoCode: "",
    originIata: i.from.toUpperCase(), destinationIata: i.to.toUpperCase(),
    tpAdults: String(a), tpTeens: "0", tpChildren: String(c), tpInfants: "0",
    tpStartDate: i.depart, ...(ret ? { tpEndDate: i.return! } : {}), tpDiscount: "0", tpPromoCode: "",
    tpOriginIata: i.from.toUpperCase(), tpDestinationIata: i.to.toUpperCase(),
  });
  return `https://www.ryanair.com/gb/en/trip/flights/select?${p.toString()}`;
}

/** easyJet's /deeplink entry (best-effort: the site answered 403 to curl; dates are dd-mm-yyyy). */
function easyjetDeep(i: FlightSearch): string {
  const p = new URLSearchParams({
    lang: "EN", dep: i.from.toUpperCase(), dest: i.to.toUpperCase(), dd: ddmmyyyy(i.depart),
    ...(i.return ? { rd: ddmmyyyy(i.return) } : {}), apax: String(adultsOf(i)), cpax: String(childrenOf(i)),
    pid: "www.easyjet.com", isOneWay: i.return ? "off" : "on",
  });
  return `https://www.easyjet.com/deeplink?${p.toString()}`;
}

export const AIRLINES: readonly Airline[] = [
  { name: "Ryanair", code: "FR", home: "https://www.ryanair.com/", deep: ryanairDeep },
  { name: "Vueling", code: "VY", home: "https://www.vueling.com/en" },
  { name: "Iberia", code: "IB", home: "https://www.iberia.com/es/en/" },
  { name: "Iberia Express", code: "I2", home: "https://www.iberiaexpress.com/" },
  { name: "Air Europa", code: "UX", home: "https://www.aireuropa.com/en/flights" },
  { name: "easyJet", code: "U2", home: "https://www.easyjet.com/en/", deep: easyjetDeep },
  { name: "Volotea", code: "V7", home: "https://www.volotea.com/en/" },
  { name: "Wizz Air", code: "W6", home: "https://wizzair.com/en-gb" },
  { name: "Transavia", code: "HV", home: "https://www.transavia.com/en-EU/home/" },
  { name: "TAP Air Portugal", code: "TP", home: "https://www.flytap.com/en-es/" },
  { name: "Binter", code: "NT", home: "https://www.bintercanarias.com/en" },
  { name: "Lufthansa", code: "LH", home: "https://www.lufthansa.com/es/en/homepage" },
  { name: "KLM", code: "KL", home: "https://www.klm.com/" },
  { name: "Air France", code: "AF", home: "https://www.airfrance.com/" },
  { name: "ITA Airways", code: "AZ", home: "https://www.ita-airways.com/" },
  { name: "Turkish Airlines", code: "TK", home: "https://www.turkishairlines.com/" },
  { name: "Emirates", code: "EK", home: "https://www.emirates.com/es/english/" },
  { name: "Qatar Airways", code: "QR", home: "https://www.qatarairways.com/" },
];

/** Carriers shown by default for a plan out of Valencia, Alicante, Madrid or Barcelona. */
export const DEFAULT_CARRIERS = ["Ryanair", "Vueling", "Iberia", "easyJet", "Volotea", "Air Europa"] as const;

/** By name ("Ryanair", "TAP"), by IATA designator ("FR"), or by a name prefix of three letters or more. */
export function findAirline(carrier: string): Airline | undefined {
  const k = carrier.trim().toLowerCase();
  if (!k) return undefined;
  return (
    AIRLINES.find((a) => a.name.toLowerCase() === k || a.code.toLowerCase() === k) ??
    (k.length >= 3 ? AIRLINES.find((a) => a.name.toLowerCase().startsWith(k)) : undefined)
  );
}

/** The airline's own page: a deep link with route and dates where known, otherwise its booking home page. */
export function airlineLink(carrier: string, i: FlightSearch): Link | null {
  const a = findAirline(carrier);
  if (!a) return null;
  return a.deep
    ? { label: `${a.name} (${i.from.toUpperCase()}–${i.to.toUpperCase()})`, url: a.deep(i) }
    : { label: `${a.name} (booking site)`, url: a.home };
}

export function airlineLinks(i: FlightSearch, carriers: readonly string[] = DEFAULT_CARRIERS): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const c of carriers) {
    const l = airlineLink(c, i);
    if (l && !seen.has(l.url + l.label)) { seen.add(l.url + l.label); out.push(l); }
  }
  return out;
}

// --- stays ----------------------------------------------------------------------------------------

export function googleHotelsLink(i: StaySearch): Link {
  return {
    label: `Google Hotels, ${i.place}`,
    url: `https://www.google.com/travel/search?q=${q(i.place)}&checkin=${i.checkIn}&checkout=${i.checkOut}&adults=${adultsOf(i)}`,
  };
}

export function bookingLink(i: StaySearch): Link {
  const url =
    `https://www.booking.com/searchresults.html?ss=${q(i.place)}&checkin=${i.checkIn}&checkout=${i.checkOut}` +
    `&group_adults=${adultsOf(i)}&no_rooms=${Math.max(1, i.rooms ?? 1)}&group_children=${childrenOf(i)}&order=review_score_and_price`;
  return { label: `Booking.com, ${i.place}`, url };
}

export function airbnbLink(i: StaySearch): Link {
  const params = [`checkin=${i.checkIn}`, `checkout=${i.checkOut}`, `adults=${adultsOf(i)}`];
  if (childrenOf(i)) params.push(`children=${childrenOf(i)}`);
  return { label: `Airbnb, ${i.place}`, url: `https://www.airbnb.com/s/${q(i.place)}/homes?${params.join("&")}` };
}

// --- cars -----------------------------------------------------------------------------------------

/**
 * Discover Cars: its country/city landing page (verified 200). The page holds the search form; the
 * dates are not carried in the URL. Without a country, the home page.
 */
export function discoverCarsLink(i: CarSearch): Link {
  const url = i.country ? `https://www.discovercars.com/${slug(i.country)}/${slug(i.place)}` : "https://www.discovercars.com/";
  return { label: `Discover Cars, ${i.place}`, url };
}

/** Rentalcars.com redirects into Booking.com cars; its search URL is not stable, so the home page. */
export function rentalcarsLink(i: CarSearch): Link {
  return { label: `Rentalcars, ${i.place}`, url: "https://www.rentalcars.com/" };
}

// --- things to do ---------------------------------------------------------------------------------

/** Google Maps search (the form Loco uses for places). */
export function googleMapsLink(place: string): Link {
  return { label: `Google Maps, ${place}`, url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` };
}

/** GetYourGuide search. best-effort: /s/?q= and date_from/date_to (site refused curl with 403). */
export function getYourGuideLink(place: string, dates?: { from: string; to: string }): Link {
  const d = dates ? `&date_from=${dates.from}&date_to=${dates.to}` : "";
  return { label: `GetYourGuide, ${place}`, url: `https://www.getyourguide.com/s/?q=${q(place)}${d}` };
}

/** Viator search. best-effort: /searchResults/all?text= (site refused curl with 403). */
export function viatorLink(place: string): Link {
  return { label: `Viator, ${place}`, url: `https://www.viator.com/searchResults/all?text=${q(place)}` };
}

// --- a whole plan ---------------------------------------------------------------------------------

export interface PlanLinksInput {
  place: string;
  country?: string;
  /** Destination airports, best first. */
  airports: string[];
  /** Origin airports, best first (profile.home_airports). */
  origins: string[];
  dates: { from: string; to: string };
  adults?: number;
  children?: number;
  rooms?: number;
  needs?: readonly string[]; // PlanRequest.needs; default all four sections
  carriers?: readonly string[];
  /** For Kiwi: city slugs of the origin, e.g. "valencia-spain". */
  originSlug?: string;
}

/** Everything the owner needs to continue by hand: flights, stay, car, activities. */
export function linksForPlan(p: PlanLinksInput): SectionLink[] {
  const needs = new Set(p.needs ?? ["flights", "stay", "car", "activities"]);
  const out: SectionLink[] = [];
  const add = (section: PlanSection, links: Link[]) => { for (const l of links) out.push({ section, ...l }); };

  if (needs.has("flights") && p.origins.length && p.airports.length) {
    const to = p.airports[0]!;
    const base = { to, depart: p.dates.from, return: p.dates.to, adults: p.adults, children: p.children };
    const first = { ...base, from: p.origins[0]!, fromSlug: p.originSlug, toSlug: p.country ? `${slug(p.place)}-${slug(p.country)}` : undefined };
    add("flights", [googleFlightsLink(first), skyscannerLink(first), kayakLink(first), kiwiLink(first)]);
    // Other home airports: one Google Flights link each, since they are the ones people forget.
    for (const o of p.origins.slice(1)) add("flights", [googleFlightsLink({ ...base, from: o })]);
    add("flights", airlineLinks(first, p.carriers));
  }
  if (needs.has("stay")) {
    const s: StaySearch = { place: p.place, checkIn: p.dates.from, checkOut: p.dates.to, adults: p.adults, children: p.children, rooms: p.rooms };
    add("stay", [googleHotelsLink(s), bookingLink(s), airbnbLink(s)]);
  }
  if (needs.has("car")) {
    const c: CarSearch = { place: p.place, country: p.country, pickup: p.dates.from, dropoff: p.dates.to, airport: p.airports[0] };
    add("car", [discoverCarsLink(c), rentalcarsLink(c)]);
  }
  if (needs.has("activities")) {
    add("activities", [getYourGuideLink(p.place, p.dates), viatorLink(p.place), googleMapsLink(p.place)]);
  }
  return out;
}
