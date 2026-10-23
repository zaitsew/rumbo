import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation, Watch } from "../src/core/schema";

export function tempDir(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rumbo-test-"));
  return { dir, path: join(dir, "rumbo.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function flight(id: string, over: Record<string, unknown> = {}): Observation {
  return {
    kind: "flight",
    id,
    title: "VLC to LIS",
    place: "Lisbon",
    tags: [],
    provenance: { source: "kiwi-mcp", url: "https://example.com/offer", seen_at: "2026-10-23T08:00:00+02:00", expires_at: "2026-10-25T08:00:00+02:00" },
    origin: "VLC",
    destination: "LIS",
    depart_date: "2026-12-06",
    return_date: "2026-12-09",
    price: { amount_minor: 8900, currency: "EUR" },
    stops: 0,
    legs: [],
    ...over,
  } as Observation;
}

export function watch(id: string, over: Record<string, unknown> = {}): Watch {
  return {
    id,
    kind: "route",
    label: "VLC to LIS",
    origin: ["VLC"],
    destination: ["LIS"],
    window: { from: "2026-12-01", to: "2026-12-31" },
    every_hours: 24,
    active: true,
    created_by: "owner",
    ...over,
  } as Watch;
}

export const PROFILE = { home_city: "Valencia", home_airports: ["VLC"], interests: { food: 2 } };
