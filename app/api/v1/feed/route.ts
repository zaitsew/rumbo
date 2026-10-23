import { ObservationSchema, type ObservationKind } from "../../../../src/core/schema";
import { ApiError, route } from "../../../../src/server/api";
import { FEED_MAX_LIMIT, getFeed } from "../../../../src/server/feed";
import { feedItemView } from "../../../../src/server/mcp/format";

export const dynamic = "force-dynamic";

const KINDS = ObservationSchema.options.map((o) => o.shape.kind.value as ObservationKind);

/** ?limit=30 &kinds=flight,stay &include_stale=1. Items are ranked best first; `raw=1` adds the full observation. */
export const GET = route((req, { store }) => {
  const q = new URL(req.url).searchParams;
  const kinds = q.get("kinds")?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
  const bad = kinds.filter((k) => !(KINDS as string[]).includes(k));
  if (bad.length > 0) throw new ApiError(400, "invalid_query", `Unknown kinds: ${bad.join(", ")}. Valid: ${KINDS.join(", ")}.`);
  const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0 && limit <= FEED_MAX_LIMIT)) {
    throw new ApiError(400, "invalid_query", `\`limit\` must be an integer from 1 to ${FEED_MAX_LIMIT}.`);
  }
  const now = new Date();
  const items = getFeed(store.userId, {
    limit,
    kinds: kinds as ObservationKind[],
    includeStale: q.get("include_stale") === "1" || q.get("include_stale") === "true",
    now,
  }, store);
  const raw = q.get("raw") === "1";
  return {
    generated_at: now.toISOString(),
    count: items.length,
    items: items.map((i) => ({ ...feedItemView(i), ...(raw ? { observation: i.observation } : {}) })),
    ...(store.getProfile() ? {} : { note: "No profile yet, so nothing is ranked. PATCH /api/v1/profile with home_city and home_airports." }),
  };
});
