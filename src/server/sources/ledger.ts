import type { CallLedger } from "./types";

/** In-memory ledger for tests and one-off scripts. The server uses a SQLite one so the cap survives restarts. */
export function createMemoryLedger(): CallLedger {
  const counts = new Map<string, number>();
  return {
    count: (source, day) => counts.get(`${source}|${day}`) ?? 0,
    add: (source, day, n) => {
      const key = `${source}|${day}`;
      counts.set(key, (counts.get(key) ?? 0) + n);
    },
  };
}
