import type { Store } from "./store";

/** Who has been writing to the feed lately, read from `provenance.agent` of the newest observations. */

export interface AgentActivity {
  /** `provenance.agent`; "server" for rows a collector wrote (no agent). */
  agent: string;
  count: number;
  last_seen_at: string;
  sources: string[];
}

export function recentAgentActivity(store: Store, limit = 20): AgentActivity[] {
  const rows = store.listStoredObservations({ limit, includeStale: true });
  const by = new Map<string, AgentActivity>();
  for (const r of rows) {
    const agent = r.observation.provenance.agent ?? "server";
    const seen = r.seen_at;
    const cur = by.get(agent);
    if (!cur) by.set(agent, { agent, count: 1, last_seen_at: seen, sources: [r.observation.provenance.source] });
    else {
      cur.count += 1;
      if (seen > cur.last_seen_at) cur.last_seen_at = seen;
      if (!cur.sources.includes(r.observation.provenance.source)) cur.sources.push(r.observation.provenance.source);
    }
  }
  return [...by.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}

/** When did this agent last post anything? ISO instant or null. */
export function lastSeenForAgent(store: Store, agent: string): string | null {
  for (const r of store.listStoredObservations({ limit: 500, includeStale: true })) {
    if (r.observation.provenance.agent === agent) return r.seen_at;
  }
  return null;
}
