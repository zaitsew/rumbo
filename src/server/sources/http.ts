import type { SearchContext } from "./types";

export class SourceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SourceError";
  }
}

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * One JSON request. Errors name the host and path but never the query string: a provider may take its key
 * there, and error text ends up in logs and the `runs` table.
 */
export async function requestJson<T>(ctx: SearchContext, req: JsonRequest): Promise<T> {
  const f = ctx.fetch ?? fetch;
  const u = new URL(req.url);
  const where = `${u.host}${u.pathname}`;
  let res: Response;
  try {
    res = await f(req.url, {
      method: req.method ?? "GET",
      headers: { accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: ctx.signal,
    });
  } catch (e) {
    throw new SourceError(`${where}: ${(e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new SourceError(`${where}: HTTP ${res.status}${text ? ` ${text}` : ""}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new SourceError(`${where}: response is not JSON`, res.status);
  }
}

/** `2026-12-04` + 3 days. UTC arithmetic, so no daylight-saving drift. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addHours(now: Date, h: number): string {
  return new Date(now.getTime() + h * 3_600_000).toISOString();
}

const exponents = new Map<string, number>();

/** ISO 4217 minor-unit exponent: JPY 0, EUR 2, KWD and BHD 3. Read from ICU; 2 for a code it does not know. */
export function minorExponent(currency: string): number {
  const code = currency.toUpperCase();
  let e = exponents.get(code);
  if (e === undefined) {
    try {
      e = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      e = 2;
    }
    exponents.set(code, e);
  }
  return e;
}

/** 12.5 EUR -> 1250; 1200 JPY -> 1200; 1.234 KWD -> 1234. */
export const toMinor = (major: number | string, currency: string): number =>
  Math.round(Number(major) * 10 ** minorExponent(currency));

/** 1250 EUR -> "12.50"; 1200 JPY -> "1200". For logs and the smoke script. */
export const formatMinor = (minor: number, currency: string): string => (minor / 10 ** minorExponent(currency)).toFixed(minorExponent(currency));
