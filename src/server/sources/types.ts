/// <reference types="node" />

import type { Observation, ObservationKind } from "../../core/schema";

/** Environment variables as the server sees them (`process.env` or a test double). */
export type Env = Record<string, string | undefined>;

type Day = string; // YYYY-MM-DD
type Iata = string; // three capital letters

/** What a collector asks of a source. One query, one kind of observation. */
export type SourceQuery =
  | {
      kind: "flights";
      origin: Iata[];
      destination: Iata[] | "anywhere";
      /** Departure dates to search. */
      window: { from: Day; to: Day };
      nights?: { min: number; max: number };
      adults: number;
      /** Children travelling (2-11). Ages are in `child_ages`; see `childAges`. */
      children?: number;
      child_ages?: number[];
      currency: string;
      max_stops?: number;
    }
  | {
      kind: "stays";
      place: string;
      /** ISO 3166-1 alpha-2, when the caller knows it. Some providers need it to resolve a city. */
      country?: string;
      check_in: Day;
      check_out: Day;
      adults: number;
      children?: number;
      child_ages?: number[];
      currency: string;
    }
  | { kind: "activities"; place: string; country?: string; date?: Day; currency?: string }
  | { kind: "events"; place: string; country?: string; window: { from: Day; to: Day } };

export type QueryKind = SourceQuery["kind"];

/** The profile stores no ages. When a source needs them, every child is this old. */
export const DEFAULT_CHILD_AGE = 8;

/** One age per child: the given ages, padded (or cut) to `children` with DEFAULT_CHILD_AGE. */
export function childAges(q: { children?: number; child_ages?: number[] }): number[] {
  const n = Math.max(0, q.children ?? q.child_ages?.length ?? 0);
  return Array.from({ length: n }, (_, i) => q.child_ages?.[i] ?? DEFAULT_CHILD_AGE);
}

/** The observation kind each query kind produces. */
export const OBSERVATION_KIND_OF: Record<QueryKind, ObservationKind> = {
  flights: "flight",
  stays: "stay",
  activities: "activity",
  events: "event",
};

export interface SearchContext {
  now: Date;
  /** Where keys are read from (defaults to `process.env`). */
  env?: Env;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface Source {
  /** Also the `provenance.source` value of everything it returns. */
  name: string;
  kinds: ObservationKind[];
  /** True when a call costs money. Paid sources are off until the owner approves the price (D2). */
  paid: boolean;
  /** Most HTTP/MCP calls per UTC day. The runner counts calls before making them. */
  dailyCap: number;
  enabled(env: Env): boolean;
  /** Why `enabled` is false, in words that name the env var to set; null when enabled. */
  why_disabled(env: Env): string | null;
  /** How many calls `search(q)` will make right now (default 1). Lets the runner charge the cap up front. */
  callsFor?(q: SourceQuery): number;
  search(q: SourceQuery, ctx: SearchContext): Promise<Observation[]>;
}

/** Calls made per source per UTC day. The foundation lane backs it with SQLite; tests use the memory one. */
export interface CallLedger {
  count(source: string, day: string): number;
  add(source: string, day: string, n: number): void;
}

export interface CallRecord {
  source: string;
  /** Calls charged to the source for this query. 0 when it was skipped. */
  n: number;
  ok: boolean;
  error?: string;
  skipped?: "disabled" | "cap";
}
