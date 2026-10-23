import type { Observation, Watch } from "../core/schema";
import { sawk } from "./sawk";
import { ALL_SOURCES, OBSERVATION_KIND_OF, queriesForWatch, runSources, type CallLedger, type CallRecord, type Env, type Source } from "./sources";
import { createCallLedger, createStore, db as processDb, recordRun, type Store } from "./store";

/**
 * The collector: every active watch whose last run is older than its `every_hours` goes through the
 * sources, and what comes back is stored with the watch's id. A scheduler (the compose fragment's
 * `scheduler` service) calls `POST /api/v1/collect` every hour; the daily caps in `runSources` bound
 * the spend however often it is called.
 */

/** Most watches one call runs, oldest first, so a long list cannot hold a request for minutes. */
export const MAX_WATCHES_PER_COLLECT = 25;

export interface CollectDeps {
  store?: Store;
  sources?: Source[];
  env?: Env;
  fetch?: typeof fetch;
  ledger?: CallLedger;
  timeoutMs?: number;
}

export interface CollectResult {
  watches_run: number;
  observations: number;
  calls: number;
}

const running = new Map<string, Promise<CollectResult>>();

export function isDue(everyHours: number, lastRunAt: string | undefined, now: Date): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  return Number.isNaN(last) || now.getTime() - last >= everyHours * 3_600_000;
}

/** Run the watches that are due. Two overlapping calls share one run. */
export function collectDue(userId: string, now: Date = new Date(), deps: CollectDeps = {}): Promise<CollectResult> {
  const live = running.get(userId);
  if (live) return live;
  const p = collect(userId, now, deps).finally(() => running.delete(userId));
  running.set(userId, p);
  return p;
}

async function collect(userId: string, now: Date, deps: CollectDeps): Promise<CollectResult> {
  const store = deps.store ?? createStore(processDb(), userId);
  const profile = store.getProfile();
  const result: CollectResult = { watches_run: 0, observations: 0, calls: 0 };
  if (!profile) return result;

  const env = deps.env ?? process.env;
  const sources = deps.sources ?? [...ALL_SOURCES, sawk];
  const ledger = deps.ledger ?? createCallLedger(store.db);
  // A watch no enabled source can serve is skipped before the batch is cut, so a pile of them cannot
  // fill the 25 places and starve a runnable watch behind them.
  const servable = (w: Watch): boolean => {
    const queries = queriesForWatch(w, profile);
    return queries.some((q) => sources.some((s) => s.kinds.includes(OBSERVATION_KIND_OF[q.kind]) && s.enabled(env)));
  };
  const due = store
    .listWatches()
    .filter((w) => w.active && isDue(w.every_hours, w.last_run_at, now) && servable(w))
    .sort((a, b) => (a.last_run_at ?? "").localeCompare(b.last_run_at ?? "") || a.id.localeCompare(b.id))
    .slice(0, MAX_WATCHES_PER_COLLECT);
  if (!due.length) return result;

  const started = now.toISOString();
  const problems: string[] = [];
  for (const watch of due) {
    const queries = queriesForWatch(watch, profile);
    if (!queries.length) continue;
    let observations: Observation[] = [];
    let calls: CallRecord[] = [];
    try {
      ({ observations, calls } = await runSources(queries, { sources, ledger, env, now, fetch: deps.fetch, timeoutMs: deps.timeoutMs }));
    } catch (err) {
      problems.push(`${watch.label}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      continue;
    }
    result.calls += calls.reduce((n, c) => n + c.n, 0);
    for (const c of calls) if (!c.ok && c.error) problems.push(`${watch.label} / ${c.source}: ${c.error}`.slice(0, 200));
    if (observations.length) {
      const stamped = observations.map((o) => ({ ...o, watch_id: watch.id }));
      const r = store.upsertObservations(stamped);
      result.observations += r.inserted + r.updated;
    }
    // A watch is stamped once a source was really called, whether it answered or failed, so a watch
    // that keeps failing waits its interval and the batch moves on. A watch the daily caps or a refused
    // key kept from calling anything stays unstamped and goes first next time. The stamp is a targeted
    // update: the watch may have been edited, paused or deleted while the sources ran.
    if (calls.some((c) => c.n > 0)) store.markWatchRun(watch.id, now.toISOString());
    if (calls.some((c) => c.ok)) result.watches_run++;
  }

  const finished = new Date().toISOString();
  recordRun(store.db, {
    id: `collect:${started}`,
    source: "collect",
    started_at: started,
    finished_at: finished,
    calls: result.calls,
    ok: true,
    error: problems.length ? problems.slice(0, 5).join(" | ").slice(0, 500) : null,
  });
  return result;
}
