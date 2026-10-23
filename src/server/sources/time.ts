/**
 * Some providers (Kiwi, Duffel) return local times without an offset; the shared schema wants an
 * instant. We never guess one: an instant is built only from a time zone we know for sure, and a leg
 * list whose zones are unknown or inconsistent is left out (the observation keeps its dates and price).
 * `withOffset("2026-12-06T05:55:00", "Europe/Lisbon")` gives "2026-12-06T05:55:00+00:00";
 * an unknown zone gives undefined.
 */
export function offsetAt(utcMs: number, timeZone: string): string | undefined {
  let name: string | undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(utcMs));
    name = parts.find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
  if (name === "GMT") return "+00:00";
  const m = name ? /GMT([+-])(\d{2}):(\d{2})/.exec(name) : null;
  return m ? `${m[1]}${m[2]}:${m[3]}` : undefined;
}

const offsetMinutes = (off: string) => (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));

export function withOffset(local: string, timeZone: string | undefined): string | undefined {
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(local)) return local;
  if (!timeZone) return undefined;
  const base = local.length === 16 ? `${local}:00` : local;
  const asUtc = Date.parse(`${base}Z`);
  if (Number.isNaN(asUtc)) return undefined;
  // The offset at the wall-clock instant: guess with UTC, then correct once.
  const first = offsetAt(asUtc, timeZone);
  if (!first) return undefined;
  const off = offsetAt(asUtc - offsetMinutes(first) * 60_000, timeZone);
  return off ? `${base}${off}` : undefined;
}

export interface LocalSegment {
  from: string; to: string;
  departLocal: string; arriveLocal: string;
  /** Provider's flight time in minutes, when it gives one. Used to cross-check the zones. */
  durationMin?: number;
  tzFrom: string | undefined; tzTo: string | undefined;
  carrier: string; flight_no?: string;
}

export interface OffsetLeg { from: string; to: string; depart_at: string; arrive_at: string; carrier: string; flight_no?: string }

/**
 * Legs with real offsets, or undefined. Undefined when any zone is unknown, or when the zones disagree
 * with the provider's own flight time by more than 10 minutes (a sign that a guessed zone is wrong).
 */
export function offsetLegs(segments: LocalSegment[]): OffsetLeg[] | undefined {
  const out: OffsetLeg[] = [];
  for (const g of segments) {
    const dep = withOffset(g.departLocal, g.tzFrom);
    const arr = withOffset(g.arriveLocal, g.tzTo);
    if (!dep || !arr) return undefined;
    if (g.durationMin !== undefined) {
      const real = (Date.parse(arr) - Date.parse(dep)) / 60_000;
      if (Math.abs(real - g.durationMin) > 10) return undefined;
    }
    out.push({ from: g.from, to: g.to, depart_at: dep, arrive_at: arr, carrier: g.carrier, flight_no: g.flight_no });
  }
  return out;
}

/**
 * Time zone of a country, by the English name Kiwi uses. Only countries with one zone on the mainland;
 * multi-zone countries (United States, Canada, Brazil, Mexico, Russia ...) are left out, so their airports
 * need an entry in AIRPORT_TZ or their legs are left out.
 */
const COUNTRY_TZ: Record<string, string> = {
  Spain: "Europe/Madrid", Portugal: "Europe/Lisbon", France: "Europe/Paris", Italy: "Europe/Rome",
  Germany: "Europe/Berlin", Austria: "Europe/Vienna", Switzerland: "Europe/Zurich", Netherlands: "Europe/Amsterdam",
  Belgium: "Europe/Brussels", Luxembourg: "Europe/Luxembourg", "United Kingdom": "Europe/London", Ireland: "Europe/Dublin",
  Iceland: "Atlantic/Reykjavik", Norway: "Europe/Oslo", Sweden: "Europe/Stockholm", Denmark: "Europe/Copenhagen",
  Finland: "Europe/Helsinki", Estonia: "Europe/Tallinn", Latvia: "Europe/Riga", Lithuania: "Europe/Vilnius",
  Poland: "Europe/Warsaw", Czechia: "Europe/Prague", "Czech Republic": "Europe/Prague", Slovakia: "Europe/Bratislava",
  Hungary: "Europe/Budapest", Slovenia: "Europe/Ljubljana", Croatia: "Europe/Zagreb", Serbia: "Europe/Belgrade",
  "Bosnia and Herzegovina": "Europe/Sarajevo", Montenegro: "Europe/Podgorica", Albania: "Europe/Tirane",
  "North Macedonia": "Europe/Skopje", Greece: "Europe/Athens", Bulgaria: "Europe/Sofia", Romania: "Europe/Bucharest",
  Moldova: "Europe/Chisinau", Ukraine: "Europe/Kyiv", Turkey: "Europe/Istanbul", Türkiye: "Europe/Istanbul", Malta: "Europe/Malta",
  Cyprus: "Asia/Nicosia", Morocco: "Africa/Casablanca", Tunisia: "Africa/Tunis", Algeria: "Africa/Algiers",
  Egypt: "Africa/Cairo", Israel: "Asia/Jerusalem", Jordan: "Asia/Amman", "United Arab Emirates": "Asia/Dubai",
  Georgia: "Asia/Tbilisi", Armenia: "Asia/Yerevan", Japan: "Asia/Tokyo", Thailand: "Asia/Bangkok",
  Singapore: "Asia/Singapore", India: "Asia/Kolkata", "Cape Verde": "Atlantic/Cape_Verde", "Cabo Verde": "Atlantic/Cape_Verde",
  Colombia: "America/Bogota", Peru: "America/Lima", Argentina: "America/Argentina/Buenos_Aires",
};

/** Airports whose zone differs from their country's main zone. */
const AIRPORT_TZ: Record<string, string> = {
  TFS: "Atlantic/Canary", TFN: "Atlantic/Canary", LPA: "Atlantic/Canary", ACE: "Atlantic/Canary", FUE: "Atlantic/Canary",
  SPC: "Atlantic/Canary", GMZ: "Atlantic/Canary", VDE: "Atlantic/Canary",
  FNC: "Atlantic/Madeira", PXO: "Atlantic/Madeira", PDL: "Atlantic/Azores", TER: "Atlantic/Azores", HOR: "Atlantic/Azores",
  SMA: "Atlantic/Azores", FLW: "Atlantic/Azores",
  JFK: "America/New_York", EWR: "America/New_York", BOS: "America/New_York", IAD: "America/New_York", ATL: "America/New_York",
  YYZ: "America/Toronto", YUL: "America/Toronto", MEX: "America/Mexico_City", GRU: "America/Sao_Paulo",
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SEA: "America/Los_Angeles", LAS: "America/Los_Angeles",
  ORD: "America/Chicago", DFW: "America/Chicago", MSY: "America/Chicago", DEN: "America/Denver", MIA: "America/New_York",
  YVR: "America/Vancouver",
};

/** The zone of an airport, or undefined when we cannot be sure. */
export function timeZoneFor(airport: string | undefined, country: string | undefined): string | undefined {
  return (airport && AIRPORT_TZ[airport]) || (country && COUNTRY_TZ[country]) || undefined;
}
