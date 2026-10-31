// Shared helpers for the security suites (Teyla Shield, SH7). Synthetic data only: every key, name and
// place below is invented. The corpus next to this file, injection_cases.json, is a byte-for-byte copy of
// templates/security/injection_cases.json in the teyla repo (version 1); update it by copying, never by editing.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import type { Db } from "../../src/server/store";
import type { Store } from "../../src/server/store";

export const OWNER_KEY = "synthetic-test-key-one";
export const WRONG_KEY = "synthetic-test-key-two";
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
export const rpc = (method: string, params: unknown = {}, id: number | string = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
export const toolCall = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

/** Set the environment the app reads, before any app module is imported. Provider keys are synthetic. */
export function bootEnv(dbPath: string, extra: Record<string, string> = {}): void {
  process.env.RUMBO_DB = dbPath;
  process.env.RUMBO_OWNER_KEY = OWNER_KEY;
  process.env.RUMBO_TRUST_PROXY = "1"; // Caddy's X-Forwarded-For names the client; tests give each caller an address
  for (const k of ["ACCOUNTS_SERVICE_RUMBO", "SAWK_URL", "SAWK_TOKEN", "RUMBO_OAUTH_ISSUER", "RUMBO_KIWI_MCP"]) delete process.env[k];
  Object.assign(process.env, extra);
}

export function resetLockout(): void {
  const reg = (globalThis as unknown as { __rumboLimiters?: Record<string, { reset(): void }> }).__rumboLimiters;
  reg?.lockout?.reset();
  reg?.api?.reset();
}

// --- Routes on disk ------------------------------------------------------------------------------

export type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response> | Response>>;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Every `route.ts` under app/, as paths relative to app/ (so a new route shows up here by itself). */
export function routeFiles(): string[] {
  const base = join(ROOT, "app");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") out.push(relative(base, p));
    }
  };
  walk(base);
  return out.sort();
}

export async function loadRoute(rel: string): Promise<RouteModule> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "app", rel)).href)) as RouteModule;
}

/** A URL path for a route file: `api/v1/plans/[id]/route.ts` -> `/api/v1/plans/p1`. */
export function urlFor(rel: string, seg: Record<string, string> = {}): { path: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const parts = dirname(rel).split("/").filter((s) => s !== ".").map((s) => {
    const m = /^\[(\[\.\.\.)?(\.\.\.)?([a-z]+)\]?\]$/i.exec(s);
    if (!m) return s;
    const name = m[3]!;
    const value = seg[name] ?? "x";
    params[name] = value;
    return encodeURIComponent(value);
  });
  return { path: "/" + parts.join("/"), params };
}

// --- Rows (tenancy) ------------------------------------------------------------------------------

/** Tables that hold per-user rows (they carry `user_id`) and tables that do not. A new table must be added to one. */
export function tableInfo(db: Db): { name: string; tenant: boolean }[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  return names.map((name) => ({
    name,
    tenant: (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === "user_id"),
  }));
}

/** All rows of one user in every tenant table, as comparable text. */
export function dumpUser(db: Db, userId: string): string {
  const out: Record<string, unknown[]> = {};
  for (const t of tableInfo(db).filter((t) => t.tenant)) {
    out[t.name] = db.prepare(`SELECT * FROM ${t.name} WHERE user_id = ? ORDER BY rowid`).all(userId);
  }
  return JSON.stringify(out);
}

/** Everything in the database, for "a refused call changed nothing". */
export function dumpAll(db: Db): string {
  const out: Record<string, unknown[]> = {};
  for (const t of tableInfo(db)) out[t.name] = db.prepare(`SELECT * FROM ${t.name} ORDER BY rowid`).all();
  return JSON.stringify(out);
}

// --- Synthetic records -----------------------------------------------------------------------------

export const NOW = new Date("2026-10-31T10:00:00+01:00");

export const idea = (title: string, over: Record<string, unknown> = {}) => ({
  kind: "idea",
  title,
  place: "Lisbon",
  summary: "A synthetic idea.",
  tags: [],
  provenance: { source: "synthetic-agent", seen_at: "2026-10-31T09:00:00+01:00", agent: "synthetic-agent" },
  ...over,
});

export function observation(id: string, title: string): unknown {
  return {
    kind: "flight", id, title, place: "Lisbon", tags: [],
    provenance: { source: "kiwi-mcp", url: "https://example.test/offer", seen_at: "2026-10-31T09:00:00+01:00", expires_at: "2026-12-31T09:00:00+01:00" },
    origin: "VLC", destination: "LIS", depart_date: "2026-12-06", return_date: "2026-12-09",
    price: { amount_minor: 8900, currency: "EUR" }, stops: 0, legs: [],
  };
}

export const watchRow = (id: string, label: string, createdBy = "owner") => ({
  id, kind: "place-events", label, place: "Lisbon", origin: [], destination: [], window: { from: "2026-12-01", to: "2026-12-31" },
  every_hours: 24, active: true, created_by: createdBy,
});

export const tripRow = (id: string, title: string, source = "synthetic-source") => ({ id, title, from: "2026-05-01", to: "2026-05-04", places: ["Lisbon"], tags: [], source });

export const planRow = (id: string, text: string) => ({
  id, created_at: "2026-10-31T09:00:00+01:00", status: "choosing",
  request: { text, window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 3, max: 5 }, interests: [], needs: ["flights"] },
  candidates: [], sections: { flights: [], stay: [], car: [], activities: [], events: [] }, links: [],
});

export const PROFILE_BODY = (city: string) => ({ home_city: city, home_airports: ["VLC"], interests: { food: 2 } });

/** Seed every tenant table of a store with rows that all carry `tag`. Returns the ids it used. */
export function seedAll(s: Store, tag: string): { obs: string; watch: string; plan: string; trip: string } {
  const ids = { obs: `obs-${tag}`, watch: `w-${tag}`, plan: `plan-${tag}`, trip: `trip-${tag}` };
  s.putProfile(PROFILE_BODY(`City-${tag}`), NOW);
  s.upsertHistory([tripRow(ids.trip, `Trip ${tag}`)]);
  s.upsertWatch(watchRow(ids.watch, `Watch ${tag}`));
  s.upsertObservations([observation(ids.obs, `Offer ${tag}`)]);
  s.addFeedback({ observation_id: ids.obs, action: "saved", note: `Note ${tag}` }, NOW);
  s.putPlan(planRow(ids.plan, `Plan ${tag}`), NOW);
  return ids;
}

// --- Outbound capture --------------------------------------------------------------------------------

export interface Seen { url: string; host: string; text: string }

/** Replace global fetch with a recorder that answers `{}`. Call `restore()` in afterEach. */
export function captureFetch(): { seen: Seen[]; restore(): void } {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.clone().text().catch(() => "");
    seen.push({ url: req.url, host: new URL(req.url).hostname, text: `${req.url} ${[...req.headers].map(([k, v]) => `${k}: ${v}`).join(" ")} ${body}` });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return { seen, restore: () => vi.unstubAllGlobals() };
}

/** Hosts docs/PRIVACY.md documents: the backticked Host column of its tables. */
export function documentedHosts(): string[] {
  const text = readFileSync(join(ROOT, "docs", "PRIVACY.md"), "utf8");
  const hosts = new Set<string>();
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[1] ?? "")) continue;
    const m = /^`([a-z0-9.-]+)`$/i.exec(cells[3] ?? "");
    if (m) hosts.add(m[1]!.toLowerCase());
  }
  return [...hosts];
}

// --- Canary forms ---------------------------------------------------------------------------------------

export function canaryForms(token: string): string[] {
  const bytes = [...new TextEncoder().encode(token)];
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  const pct = bytes.map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  return [token, Buffer.from(token).toString("base64").replace(/=+$/, ""), pct, pct.toLowerCase(), hex, [...token].reverse().join("")];
}
export const stripInvisible = (s: string) => s.replace(/[​‌‍⁠﻿]/g, "");
