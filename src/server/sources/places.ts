/**
 * City name and country for the airports a Valencia traveller meets, so an observation's `place` is a
 * city ("Lisbon") rather than a code. Sources that return names (Kiwi, Duffel) never use this table; it
 * is for Travelpayouts, which returns codes only. An unknown airport falls back to its code.
 * The destination data in `data/destinations` (core-rank lane) is the richer join; this is a bridge.
 */
export const AIRPORTS: Record<string, { city: string; country: string }> = {
  VLC: { city: "Valencia", country: "ES" }, ALC: { city: "Alicante", country: "ES" }, MAD: { city: "Madrid", country: "ES" },
  BCN: { city: "Barcelona", country: "ES" }, AGP: { city: "Malaga", country: "ES" }, SVQ: { city: "Seville", country: "ES" },
  PMI: { city: "Palma", country: "ES" }, IBZ: { city: "Ibiza", country: "ES" }, MAH: { city: "Menorca", country: "ES" },
  TFS: { city: "Tenerife", country: "ES" }, LPA: { city: "Gran Canaria", country: "ES" }, ACE: { city: "Lanzarote", country: "ES" },
  FUE: { city: "Fuerteventura", country: "ES" }, BIO: { city: "Bilbao", country: "ES" }, SCQ: { city: "Santiago de Compostela", country: "ES" },
  GRX: { city: "Granada", country: "ES" }, XRY: { city: "Jerez", country: "ES" },
  LIS: { city: "Lisbon", country: "PT" }, OPO: { city: "Porto", country: "PT" }, FAO: { city: "Faro", country: "PT" }, FNC: { city: "Funchal", country: "PT" },
  PDL: { city: "Ponta Delgada", country: "PT" },
  LON: { city: "London", country: "GB" }, LHR: { city: "London", country: "GB" }, LGW: { city: "London", country: "GB" }, STN: { city: "London", country: "GB" },
  EDI: { city: "Edinburgh", country: "GB" }, MAN: { city: "Manchester", country: "GB" }, DUB: { city: "Dublin", country: "IE" },
  PAR: { city: "Paris", country: "FR" }, CDG: { city: "Paris", country: "FR" }, ORY: { city: "Paris", country: "FR" }, NCE: { city: "Nice", country: "FR" },
  MRS: { city: "Marseille", country: "FR" }, LYS: { city: "Lyon", country: "FR" }, TLS: { city: "Toulouse", country: "FR" },
  ROM: { city: "Rome", country: "IT" }, FCO: { city: "Rome", country: "IT" }, MIL: { city: "Milan", country: "IT" }, MXP: { city: "Milan", country: "IT" },
  BGY: { city: "Milan", country: "IT" }, VCE: { city: "Venice", country: "IT" }, NAP: { city: "Naples", country: "IT" }, FLR: { city: "Florence", country: "IT" },
  PSA: { city: "Pisa", country: "IT" }, BLQ: { city: "Bologna", country: "IT" }, CTA: { city: "Catania", country: "IT" }, PMO: { city: "Palermo", country: "IT" },
  CAG: { city: "Cagliari", country: "IT" }, TRN: { city: "Turin", country: "IT" },
  BER: { city: "Berlin", country: "DE" }, MUC: { city: "Munich", country: "DE" }, FRA: { city: "Frankfurt", country: "DE" }, HAM: { city: "Hamburg", country: "DE" },
  VIE: { city: "Vienna", country: "AT" }, ZRH: { city: "Zurich", country: "CH" }, GVA: { city: "Geneva", country: "CH" },
  AMS: { city: "Amsterdam", country: "NL" }, BRU: { city: "Brussels", country: "BE" }, CPH: { city: "Copenhagen", country: "DK" },
  ARN: { city: "Stockholm", country: "SE" }, OSL: { city: "Oslo", country: "NO" }, HEL: { city: "Helsinki", country: "FI" }, KEF: { city: "Reykjavik", country: "IS" },
  PRG: { city: "Prague", country: "CZ" }, BUD: { city: "Budapest", country: "HU" }, WAW: { city: "Warsaw", country: "PL" }, KRK: { city: "Krakow", country: "PL" },
  ATH: { city: "Athens", country: "GR" }, SKG: { city: "Thessaloniki", country: "GR" }, HER: { city: "Heraklion", country: "GR" },
  IST: { city: "Istanbul", country: "TR" }, SAW: { city: "Istanbul", country: "TR" }, DBV: { city: "Dubrovnik", country: "HR" }, SPU: { city: "Split", country: "HR" },
  ZAG: { city: "Zagreb", country: "HR" }, MLA: { city: "Malta", country: "MT" }, TLL: { city: "Tallinn", country: "EE" }, RIX: { city: "Riga", country: "LV" },
  VNO: { city: "Vilnius", country: "LT" }, SOF: { city: "Sofia", country: "BG" }, OTP: { city: "Bucharest", country: "RO" }, TBS: { city: "Tbilisi", country: "GE" },
  RAK: { city: "Marrakech", country: "MA" }, CMN: { city: "Casablanca", country: "MA" }, TUN: { city: "Tunis", country: "TN" }, CAI: { city: "Cairo", country: "EG" },
  DXB: { city: "Dubai", country: "AE" }, TLV: { city: "Tel Aviv", country: "IL" }, NYC: { city: "New York", country: "US" }, JFK: { city: "New York", country: "US" },
  EWR: { city: "New York", country: "US" }, BOS: { city: "Boston", country: "US" }, MIA: { city: "Miami", country: "US" }, LAX: { city: "Los Angeles", country: "US" },
  SFO: { city: "San Francisco", country: "US" }, YTO: { city: "Toronto", country: "CA" }, MEX: { city: "Mexico City", country: "MX" },
  BKK: { city: "Bangkok", country: "TH" }, TYO: { city: "Tokyo", country: "JP" }, SIN: { city: "Singapore", country: "SG" },
  SID: { city: "Sal", country: "CV" }, RUN: { city: "Reunion", country: "RE" },
};

export function placeOfAirport(code: string): { city: string; country?: string } {
  return AIRPORTS[code] ?? { city: code };
}

/** ISO-2 country of a city name, from the table above. */
export function countryOfCity(city: string): string | undefined {
  const c = city.trim().toLowerCase();
  return Object.values(AIRPORTS).find((a) => a.city.toLowerCase() === c)?.country;
}
