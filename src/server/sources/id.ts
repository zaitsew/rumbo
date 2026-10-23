import { createHash } from "node:crypto";
import type { ObservationKind } from "../../core/schema";

/**
 * NFKC, lower-case, anything that is not a letter, mark or digit of any script becomes one space.
 * "Café  Del Mar!" and "café del mar" match; "東京ホテル" and "京都ホテル" stay different.
 */
export function norm(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** "TP" + "1097", "tp 1097" and "TP1097" all give "TP1097". */
export function flightNo(carrierCode: string | undefined, number: string | undefined): string {
  const n = (number ?? "").replace(/\s+/g, "").toUpperCase();
  const c = (carrierCode ?? "").replace(/\s+/g, "").toUpperCase();
  if (!n) return "";
  // "TP1097" already carries its IATA designator: keep it whatever the carrier field says
  // ("TP" from a collector, "TAP Air Portugal" from an agent), so both land on one id.
  if (/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(n) && /^[A-Z]/.test(n)) return n;
  return n.startsWith(c) ? n : `${c}${n}`;
}

/**
 * Stable observation id: sha256 of the kind plus key fields that do not depend on which source saw the
 * offer (origin, destination, dates, first flight number, venue). Seeing the same offer again, from this
 * source or another, updates one row. The price is never part of the key.
 */
export function observationId(kind: ObservationKind, ...parts: (string | number | undefined | null)[]): string {
  const key = [kind, ...parts.map((p) => norm(String(p ?? "")))].join("|");
  return `${kind.slice(0, 3)}_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/**
 * One leg of a flight id: flight number (or the airport pair when the source has none) plus the local
 * departure day. `departLocal` is the provider's own string, e.g. "2026-12-06T05:55:00".
 */
export function legKey(leg: { carrier?: string; number?: string; from: string; to: string; departLocal: string }): string {
  // Airports and the local departure minute are always part of the key: two itineraries with the same
  // flight numbers and day but other times or connections never collide.
  const no = flightNo(leg.carrier, leg.number);
  return `${no}:${leg.from}-${leg.to}@${leg.departLocal.slice(0, 16)}`;
}

/**
 * Flight id. `legs` lists every leg of both directions in order, so two itineraries that share their
 * first outbound flight but differ on a connection or on the return get different ids. A source that
 * only knows the first outbound flight (Travelpayouts) passes just that one.
 */
export function flightId(o: {
  origin: string;
  destination: string;
  depart_date: string;
  return_date?: string;
  legs?: string[];
}): string {
  return observationId("flight", o.origin, o.destination, o.depart_date, o.return_date ?? "oneway", ...(o.legs ?? []));
}
