import { ObservationSchema, type Observation, type Profile, type Watch } from "../../core/schema";
import { SourceError, addDays } from "./http";
import { countryOfCity } from "./places";
import { duffel } from "./duffel";
import { kiwi } from "./kiwi";
import { liteapi } from "./liteapi";
import { tiqets } from "./tiqets";
import { travelpayouts } from "./travelpayouts";
import { viator } from "./viator";
import { OBSERVATION_KIND_OF, type CallLedger, type CallRecord, type Env, type Source, type SourceQuery } from "./types";

export * from "./types";
export { createMemoryLedger } from "./ledger";
export { observationId, flightId, flightNo } from "./id";
export { kiwi, travelpayouts, viator, tiqets, liteapi, duffel };

/** Free sources first, paid last. Paid ones stay disabled until their env flag approves the price (D2). */
export const ALL_SOURCES: Source[] = [kiwi, travelpayouts, viator, tiqets, liteapi, duffel];

/** What `./check.sh` and the agents page print: each source, whether it runs, and what to set if not. */
export function describeSources(env: Env, sources: Source[] = ALL_SOURCES) {
  return sources.map((s) => ({
    name: s.name,
    kinds: s.kinds,
    paid: s.paid,
    dailyCap: s.dailyCap,
    enabled: s.enabled(env),
    why_disabled: s.why_disabled(env),
  }));
}

/** Turn a watch into the queries that serve it. A watch with nothing to search returns []. */
export function queriesForWatch(watch: Watch, profile: Profile): SourceQuery[] {
  const adults = profile.travellers.adults;
  const currency = profile.currency;
  const origin = watch.origin.length ? watch.origin : profile.home_airports;
  switch (watch.kind) {
    case "route":
      if (!watch.destination.length) return [];
      return [{ kind: "flights", origin, destination: watch.destination, window: watch.window, nights: watch.nights, adults, currency, max_stops: profile.flight.max_stops }];
    case "anywhere":
      return [{ kind: "flights", origin, destination: "anywhere", window: watch.window, nights: watch.nights, adults, currency, max_stops: profile.flight.max_stops }];
    case "place-events":
      if (!watch.place) return [];
      return [{ kind: "events", place: watch.place, country: countryOfCity(watch.place), window: watch.window }];
    case "place-stays": {
      if (!watch.place) return [];
      const nights = Math.max(1, watch.nights?.min ?? 2);
      return [{ kind: "stays", place: watch.place, country: countryOfCity(watch.place), check_in: watch.window.from, check_out: addDays(watch.window.from, nights), adults, currency }];
    }
    case "place-activities":
      if (!watch.place) return [];
      return [{ kind: "activities", place: watch.place, country: countryOfCity(watch.place), date: watch.window.from === watch.window.to ? watch.window.from : undefined, currency }];
  }
}

export interface RunOptions {
  sources: Source[];
  ledger: CallLedger;
  env: Env;
  now: Date;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Per search. Default 30 s. */
  timeoutMs?: number;
}

export interface RunResult {
  observations: Observation[];
  calls: CallRecord[];
}

function priceMinor(o: Observation): number | undefined {
  switch (o.kind) {
    case "flight": return o.price.amount_minor;
    case "stay": return o.price_total.amount_minor;
    case "activity": return o.price?.amount_minor;
    case "event": return o.price_from?.amount_minor;
    case "car": return o.price_total?.amount_minor;
    default: return undefined;
  }
}

/**
 * Run every query on every enabled source that serves its kind. Calls are counted against the source's
 * daily cap before they are made; a source that fails does not stop the others; a source that answers
 * 401, 403 or 429 gets no more queries this run. The same offer seen twice keeps its cheapest price.
 */
export async function runSources(queries: SourceQuery[], opts: RunOptions): Promise<RunResult> {
  const { ledger, env, now } = opts;
  const day = now.toISOString().slice(0, 10);

  const perSource = await Promise.all(
    opts.sources.map(async (src) => {
      const calls: CallRecord[] = [];
      const found: Observation[] = [];
      const mine = queries.filter((q) => src.kinds.includes(OBSERVATION_KIND_OF[q.kind]));
      if (!mine.length) return { calls, found };

      if (!src.enabled(env)) {
        calls.push({ source: src.name, n: 0, ok: false, skipped: "disabled", error: src.why_disabled(env) ?? "disabled" });
        return { calls, found };
      }

      let blocked: string | undefined;
      for (const q of mine) {
        if (blocked) {
          calls.push({ source: src.name, n: 0, ok: false, skipped: "disabled", error: blocked });
          continue;
        }
        const n = Math.max(0, src.callsFor?.(q) ?? 1);
        const used = ledger.count(src.name, day);
        if (n === 0) continue;
        if (used + n > src.dailyCap) {
          calls.push({ source: src.name, n: 0, ok: false, skipped: "cap", error: `daily cap ${src.dailyCap} reached (${used} used, ${n} needed)` });
          continue;
        }
        ledger.add(src.name, day, n); // charged before the call: a crash must not hide the spend
        try {
          const signal = opts.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)])
            : AbortSignal.timeout(opts.timeoutMs ?? 30_000);
          const raw = await src.search(q, { now, env, signal, fetch: opts.fetch });
          const valid: Observation[] = [];
          let dropped = 0;
          for (const o of raw) {
            const p = ObservationSchema.safeParse(o);
            if (p.success) valid.push(p.data);
            else dropped++;
          }
          found.push(...valid);
          calls.push({ source: src.name, n, ok: true, ...(dropped ? { error: `dropped ${dropped} invalid observation(s)` } : {}) });
        } catch (e) {
          const status = e instanceof SourceError ? e.status : undefined;
          const msg = (e as Error).message ?? String(e);
          calls.push({ source: src.name, n, ok: false, error: msg.slice(0, 300) });
          if (status === 401 || status === 403 || status === 429) blocked = `skipped after ${msg.slice(0, 120)}`;
        }
      }
      return { calls, found };
    }),
  );

  const byId = new Map<string, Observation>();
  for (const { found } of perSource) {
    for (const o of found) {
      const prev = byId.get(o.id);
      if (!prev) { byId.set(o.id, o); continue; }
      const a = priceMinor(prev), b = priceMinor(o);
      if (a !== undefined && b !== undefined && b < a) byId.set(o.id, o);
    }
  }
  return { observations: [...byId.values()], calls: perSource.flatMap((s) => s.calls) };
}
