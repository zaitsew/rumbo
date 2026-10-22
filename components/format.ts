import type { Money, Observation } from "../src/core/schema";

/** Decimal places of a currency (EUR 2, JPY 0), from Intl, so minor units convert without a table. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Minor units to text: `{8900, EUR}` is "€89"; `{8950, EUR}` is "€89.50". */
export function formatMoney(m: Money, locale = "en-GB"): string {
  const digits = currencyDigits(m.currency);
  const major = m.amount_minor / 10 ** digits;
  const fraction = Number.isInteger(major) ? 0 : digits;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(major);
  } catch {
    return `${major.toFixed(fraction)} ${m.currency}`;
  }
}

/** Major units typed in a form to minor units. */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDigits(currency));
}

/** Minor units to the number shown in a form field. */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

/** The headline price of an observation, if it has one. */
export function observationPrice(o: Observation): Money | undefined {
  switch (o.kind) {
    case "flight":
    case "activity":
      return o.price;
    case "stay":
    case "car":
      return o.price_total;
    case "event":
      return o.price_from;
    case "idea":
      return undefined;
  }
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const STAMP_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** "6 Dec" from a YYYY-MM-DD day. */
export function formatDay(day: string): string {
  return DAY.format(new Date(`${day}T00:00:00Z`));
}

/** "23 Oct, 06:00 UTC" from an instant; the year is added when it is not the current one. */
export function formatStamp(instant: string, now: Date = new Date()): string {
  const d = new Date(instant);
  const fmt = d.getUTCFullYear() === now.getUTCFullYear() ? STAMP : STAMP_YEAR;
  return `${fmt.format(d)} UTC`;
}

export function isStale(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= now.getTime();
}

/** One line of facts for a card, by kind. */
export function observationFacts(o: Observation): string {
  switch (o.kind) {
    case "flight": {
      const dates = o.return_date ? `${formatDay(o.depart_date)} to ${formatDay(o.return_date)}` : formatDay(o.depart_date);
      const stops = o.stops === 0 ? "direct" : `${o.stops} stop${o.stops > 1 ? "s" : ""}`;
      return `${o.origin} to ${o.destination} · ${dates} · ${stops}`;
    }
    case "stay":
      return `${o.name} · ${formatDay(o.check_in)} to ${formatDay(o.check_out)}${o.rating ? ` · rated ${o.rating}` : ""}`;
    case "car":
      return `Pickup ${o.pickup} · ${formatDay(o.pickup_date)} to ${formatDay(o.dropoff_date)}`;
    case "activity":
      return o.date ? formatDay(o.date) : "Any day";
    case "event":
      return `${formatDay(o.date)}${o.end_date ? ` to ${formatDay(o.end_date)}` : ""}${o.venue ? ` · ${o.venue}` : ""}`;
    case "idea":
      return o.summary;
  }
}
