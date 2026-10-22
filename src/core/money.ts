import type { Money } from "./schema";

/** Pure helpers for money and dates shared by the ranker, the destination scorer and the exports. */

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "€38", "€38.50", "CHF 120". Built from minor units only, so no float rounds a fare. */
export function formatMoney(m: Money): string {
  const whole = Math.trunc(m.amount_minor / 100);
  const cents = m.amount_minor % 100;
  const num = cents === 0 ? group(whole) : `${group(whole)}.${String(cents).padStart(2, "0")}`;
  const sym = SYMBOLS[m.currency];
  return sym ? `${sym}${num}` : `${m.currency} ${num}`;
}

/** Median of integers; the mean of the two middle values (rounded) for an even count. */
export function medianInt(values: number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** 155 -> "2 h 35 min", 120 -> "2 h", 45 -> "45 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (month1to12: number): string => MONTHS[month1to12 - 1] ?? "";

const DAY_MS = 86_400_000;
/** "YYYY-MM-DD" -> ms at 00:00 UTC. NaN for a malformed day. */
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((dayMs(b) - dayMs(a)) / DAY_MS);

/** "6–9 Dec", "28 Nov–3 Dec", "6 Dec" (inputs are YYYY-MM-DD). */
export function formatDayRange(from: string, to: string): string {
  const [, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (from === to) return `${fd} ${monthName(fm)}`;
  if (fm === tm) return `${fd}–${td} ${monthName(fm)}`;
  return `${fd} ${monthName(fm)}–${td} ${monthName(tm)}`;
}
