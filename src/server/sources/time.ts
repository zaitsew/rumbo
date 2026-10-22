/**
 * Some providers (Kiwi, Duffel) return local times without an offset; the shared schema wants an offset.
 * `withOffset("2026-12-06T05:55:00", "Europe/Lisbon")` gives "2026-12-06T05:55:00+00:00".
 */
export function offsetAt(utcMs: number, timeZone: string): string {
  let name = "GMT";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(utcMs));
    name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  } catch {
    return "+00:00";
  }
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? `${m[1]}${m[2]}:${m[3]}` : "+00:00";
}

export function withOffset(local: string, timeZone: string): string {
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(local)) return local;
  const base = local.length === 16 ? `${local}:00` : local;
  const asUtc = Date.parse(`${base}Z`);
  if (Number.isNaN(asUtc)) return local;
  // The offset at the wall-clock instant: guess with UTC, then correct once.
  let off = offsetAt(asUtc, timeZone);
  const sign = off[0] === "-" ? -1 : 1;
  const mins = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  off = offsetAt(asUtc - mins * 60_000, timeZone);
  return `${base}${off}`;
}

/** Main time zone of a country, by the English name Kiwi uses. Multi-zone countries get their capital's zone. */
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
  Mexico: "America/Mexico_City", Colombia: "America/Bogota", Peru: "America/Lima", Argentina: "America/Argentina/Buenos_Aires",
  "United States": "America/New_York", Canada: "America/Toronto", Brazil: "America/Sao_Paulo",
};

/** Airports whose zone differs from their country's main zone. */
const AIRPORT_TZ: Record<string, string> = {
  TFS: "Atlantic/Canary", TFN: "Atlantic/Canary", LPA: "Atlantic/Canary", ACE: "Atlantic/Canary", FUE: "Atlantic/Canary",
  SPC: "Atlantic/Canary", GMZ: "Atlantic/Canary", VDE: "Atlantic/Canary",
  FNC: "Atlantic/Madeira", PXO: "Atlantic/Madeira", PDL: "Atlantic/Azores", TER: "Atlantic/Azores",
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SEA: "America/Los_Angeles", LAS: "America/Los_Angeles",
  ORD: "America/Chicago", DFW: "America/Chicago", MSY: "America/Chicago", DEN: "America/Denver", MIA: "America/New_York",
  YVR: "America/Vancouver",
};

export function timeZoneFor(airport: string | undefined, country: string | undefined): string {
  return (airport && AIRPORT_TZ[airport]) || (country && COUNTRY_TZ[country]) || "UTC";
}
