import { createHash } from "node:crypto";
import type { ObservationKind } from "../../core/schema";

/** Lower-case, strip accents and punctuation, collapse spaces: "Café  Del Mar!" and "cafe del mar" match. */
export function norm(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "TP" + "1097", "tp 1097" and "TP1097" all give "TP1097". */
export function flightNo(carrierCode: string | undefined, number: string | undefined): string {
  const n = (number ?? "").replace(/\s+/g, "").toUpperCase();
  const c = (carrierCode ?? "").replace(/\s+/g, "").toUpperCase();
  if (!n) return "";
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

export function flightId(o: {
  origin: string;
  destination: string;
  depart_date: string;
  return_date?: string;
  first_flight?: string;
}): string {
  return observationId("flight", o.origin, o.destination, o.depart_date, o.return_date ?? "oneway", o.first_flight ?? "");
}
