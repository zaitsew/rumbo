import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceQuery } from "../src/server/sources/types";

export const NOW = new Date("2026-10-23T08:00:00Z");

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "sources", name), "utf8")) as T;
}

export interface Seen { url: string; method: string; headers: Record<string, string>; body?: any }

/** A fetch that answers from a route table and records every request. No network. */
export function fakeFetch(routes: (req: Seen) => unknown | { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: Seen = { url: String(url), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const out = routes(req) as any;
    if (out && typeof out === "object" && "status" in out && typeof out.status === "number") {
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

export const flightsVlcLis: Extract<SourceQuery, { kind: "flights" }> = {
  kind: "flights", origin: ["VLC"], destination: ["LIS"],
  window: { from: "2026-12-04", to: "2026-12-06" }, nights: { min: 3, max: 4 }, adults: 1, currency: "EUR", max_stops: 1,
};
