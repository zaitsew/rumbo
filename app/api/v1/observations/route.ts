import { ObservationSchema, type ObservationKind } from "../../../../src/core/schema";
import { ApiError, readJson, route } from "../../../../src/server/api";
import { cleanAgent } from "../../../../src/server/mcp/tool";
import { ingestObservations } from "../../../../src/server/observe";

export const dynamic = "force-dynamic";

const KINDS = ObservationSchema.options.map((o) => o.shape.kind.value as ObservationKind);
const MAX_PER_CALL = 200;

/** ?kinds=flight,stay &since=<ISO instant> &include_stale=1 &limit=100 */
export const GET = route((req, { store }) => {
  const q = new URL(req.url).searchParams;
  const kinds = q.get("kinds")?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
  const bad = kinds.filter((k) => !(KINDS as string[]).includes(k));
  if (bad.length > 0) throw new ApiError(400, "invalid_query", `Unknown kinds: ${bad.join(", ")}. Valid: ${KINDS.join(", ")}.`);
  const since = q.get("since") ?? undefined;
  if (since && Number.isNaN(Date.parse(since))) throw new ApiError(400, "invalid_query", "`since` must be an ISO 8601 instant.");
  const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new ApiError(400, "invalid_query", "`limit` must be a positive integer.");
  const observations = store.listObservations({
    kinds: kinds as ObservationKind[],
    since,
    includeStale: q.get("include_stale") === "1" || q.get("include_stale") === "true",
    limit,
  });
  return { observations };
});

/**
 * Body: an array of observations (or `{ observations: [...], agent?, checked_watch_ids? }`), at most 200.
 * Rows are checked one by one: valid ones are saved even when others are rejected. `id` is optional (the
 * server derives it) and a price needs `provenance.url`. `agent` (body, `?agent=` or X-Rumbo-Agent) is
 * stamped into provenance. `accepted` counts valid rows; `skipped_older` of them were not stored because
 * a newer sighting exists. Watches named by `watch_id` or `checked_watch_ids` are marked as run.
 */
export const POST = route(async (req, { store }) => {
  const body = await readJson(req);
  const obj = !Array.isArray(body) && typeof body === "object" && body !== null ? (body as { observations?: unknown; agent?: unknown; checked_watch_ids?: unknown }) : null;
  const list = Array.isArray(body) ? body : obj?.observations;
  if (!Array.isArray(list)) throw new ApiError(400, "invalid_body", "Send an array of observations.");
  if (list.length > MAX_PER_CALL) throw new ApiError(413, "too_many", `At most ${MAX_PER_CALL} observations per call; got ${list.length}.`);
  const agent =
    cleanAgent(typeof obj?.agent === "string" ? obj.agent : null) ??
    cleanAgent(new URL(req.url).searchParams.get("agent")) ??
    cleanAgent(req.headers.get("x-rumbo-agent")) ??
    undefined;
  const checked = Array.isArray(obj?.checked_watch_ids) ? obj.checked_watch_ids.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;
  return ingestObservations(store, list, { agent, checkedWatchIds: checked });
});
