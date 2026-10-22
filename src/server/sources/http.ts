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
 * One JSON request. Errors name the host and path but never the query string: Ticketmaster takes its key
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

export const toMinor = (major: number | string): number => Math.round(Number(major) * 100);
