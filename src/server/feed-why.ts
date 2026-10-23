import type { FeedItem } from "../core/schema";
import { aiEnabled, aiWhy, type AiOptions } from "./ai";

/**
 * The AI "why" line for the top of the feed. `aiWhy` already drops any sentence with a number the ranker
 * did not give, so a line shown here cannot carry a price or a date of the model's own (D3). This adds
 * what a page needs on top: only the best few items, calls in parallel, and a cache, so a reload does not
 * pay for the same sentence twice and a failing hub costs one timeout per ten minutes, not one per view.
 */

export const WHY_TOP = 6;
const HIT_TTL_MS = 6 * 3_600_000;
const MISS_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

const cache = new Map<string, { line: string | null; until: number }>();

export function resetWhyCache(): void {
  cache.clear();
}

const keyOf = (i: FeedItem) => `${i.observation.id}|${i.reasons.join("|")}`;

export interface WhyOptions {
  /** Most items to ask about, best first. */
  limit?: number;
  ai?: AiOptions;
  now?: Date;
}

/** The same items, with `why` set on the top ones the model could say something grounded about. */
export async function withWhy(items: FeedItem[], opts: WhyOptions = {}): Promise<FeedItem[]> {
  if (!aiEnabled(opts.ai?.env)) return items;
  const now = (opts.now ?? new Date()).getTime();
  const top = items.slice(0, opts.limit ?? WHY_TOP);
  const lines = await Promise.all(
    top.map(async (item) => {
      if (item.why || !item.reasons.length) return item.why ?? null;
      const key = keyOf(item);
      const hit = cache.get(key);
      if (hit && hit.until > now) return hit.line;
      const line = await aiWhy(item.reasons, item.observation.title, opts.ai);
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(key, { line, until: now + (line ? HIT_TTL_MS : MISS_TTL_MS) });
      return line;
    }),
  );
  return items.map((item, i) => (i < top.length && lines[i] ? { ...item, why: lines[i]! } : item));
}
