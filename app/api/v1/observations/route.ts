import { ObservationSchema, type ObservationKind } from "../../../../src/core/schema";
import { ApiError, readJson, route, zodDetail } from "../../../../src/server/api";

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

/** Body: an array of observations (or `{ observations: [...] }`), at most 200. Valid ones are saved even when others are rejected; one older than the stored copy is `skipped_older`. */
export const POST = route(async (req, { store }) => {
  const body = await readJson(req);
  const list = Array.isArray(body) ? body : (body as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(list)) throw new ApiError(400, "invalid_body", "Send an array of observations.");
  if (list.length > MAX_PER_CALL) throw new ApiError(413, "too_many", `At most ${MAX_PER_CALL} observations per call; got ${list.length}.`);

  const valid: unknown[] = [];
  const rejected: { index: number; error: string }[] = [];
  list.forEach((item, index) => {
    const parsed = ObservationSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else rejected.push({ index, error: zodDetail(parsed.error).map((d) => `${d.path || "(root)"}: ${d.message}`).join("; ") });
  });
  const { inserted, updated, skipped_older } = store.upsertObservations(valid);
  // `accepted` counts valid observations; `skipped_older` of them were not stored because a newer copy exists.
  return { accepted: valid.length, inserted, updated, skipped_older, rejected };
});
