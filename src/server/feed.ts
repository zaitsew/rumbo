import { rank, type RankFeedback } from "../core/rank";
import type { Feedback, FeedItem, ObservationKind } from "../core/schema";
import { FeedbackSchema } from "../core/schema";
import { loadDestinations } from "./destinations";
import { createStore, db, type Store, type StoredFeedback } from "./store";

/**
 * The feed: `rank()` over what the store holds. Deterministic and fast, no I/O besides SQLite and
 * the cached destination files. The AI "why" line is added on top by the plan-feed lane; nothing
 * here calls a model (D3).
 */

export interface FeedOptions {
  limit?: number;
  kinds?: ObservationKind[];
  /** Keep items marked stale (expired price, past date). Off by default: a stale price is not a recommendation. */
  includeStale?: boolean;
  now?: Date;
}

export const FEED_DEFAULT_LIMIT = 30;
export const FEED_MAX_LIMIT = 200;
/** Most observations ranked at once; older ones fall off the end of the store's newest-first list. */
const POOL = 3000;

export class FeedError extends Error {
  constructor(
    public code: "unknown_observation",
    message: string,
  ) {
    super(message);
  }
}

function storeFor(userId: string, s?: Store): Store {
  return s ?? createStore(db(), userId);
}

/**
 * Ranked feed items, best first. Every observation is ranked (baselines and "seen places" need the
 * whole pool), then `kinds`, staleness and `limit` are applied. No profile yet means an empty feed:
 * there is nobody to rank for.
 */
export function getFeed(userId: string, opts: FeedOptions = {}, s?: Store): FeedItem[] {
  const st = storeFor(userId, s);
  const profile = st.getProfile();
  if (!profile) return [];
  const now = opts.now ?? new Date();
  const observations = st.listObservations({ includeStale: true, limit: POOL, now });
  const feedback: RankFeedback[] = st.listFeedback().map((f) => ({ observation_id: f.observation_id, action: f.action, at: f.at }));
  let items = rank(observations, {
    profile,
    history: st.listHistory(),
    feedback,
    now,
    destinations: loadDestinations(),
    watches: st.listWatches(),
  });
  if (!opts.includeStale) items = items.filter((i) => !i.stale);
  if (opts.kinds && opts.kinds.length > 0) {
    const kinds = new Set<string>(opts.kinds);
    items = items.filter((i) => kinds.has(i.observation.kind));
  }
  const limit = Math.max(1, Math.min(opts.limit ?? FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT));
  return items.slice(0, limit);
}

/** Saves the owner's reaction to an observation; the next `getFeed` reflects it. */
export function recordFeedback(userId: string, input: Feedback, s?: Store, now: Date = new Date()): StoredFeedback {
  const st = storeFor(userId, s);
  const fb = FeedbackSchema.parse(input);
  if (!st.getObservation(fb.observation_id)) throw new FeedError("unknown_observation", `No observation ${fb.observation_id}.`);
  return st.addFeedback(fb, now);
}
