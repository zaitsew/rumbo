import { PastTripSchema } from "../../../../src/core/schema";
import { ApiError, readJson, route, zodDetail } from "../../../../src/server/api";

export const dynamic = "force-dynamic";
const MAX_PER_CALL = 200;

export const GET = route((_req, { store }) => ({ history: store.listHistory() }));

/** Body: one past trip or an array of them (at most 200); upserted by `id`. All or nothing. */
export const POST = route(async (req, { store }) => {
  const body = await readJson(req);
  const list = Array.isArray(body) ? body : [body];
  if (list.length > MAX_PER_CALL) throw new ApiError(413, "too_many", `At most ${MAX_PER_CALL} trips per call.`);
  const trips = list.map((t, index) => {
    const parsed = PastTripSchema.safeParse(t);
    if (!parsed.success) throw new ApiError(400, "invalid_body", { index, issues: zodDetail(parsed.error) });
    return parsed.data;
  });
  return { accepted: store.upsertHistory(trips).count };
});

const MAX_PER_SOURCE = 2000;

/**
 * `?source=loco` and a body that is that source's WHOLE history (at most 2000 trips): the rows that
 * source sent before are replaced (D8). Loco's server sends the owner's ended visits this way, so a
 * visit removed in Loco leaves Rumbo too. Other sources' rows are untouched. All or nothing.
 */
export const PUT = route(async (req, { store }) => {
  const source = new URL(req.url).searchParams.get("source")?.trim();
  if (!source || !/^[a-z][a-z0-9-]{0,31}$/.test(source)) throw new ApiError(400, "invalid_source", "Pass ?source=<name>, e.g. ?source=loco.");
  const body = await readJson(req);
  if (!Array.isArray(body)) throw new ApiError(400, "invalid_body", "Send an array: the source's whole history.");
  if (body.length > MAX_PER_SOURCE) throw new ApiError(413, "too_many", `At most ${MAX_PER_SOURCE} trips per source.`);
  const trips = body.map((t, index) => {
    const parsed = PastTripSchema.safeParse(t);
    if (!parsed.success) throw new ApiError(400, "invalid_body", { index, issues: zodDetail(parsed.error) });
    if (parsed.data.source !== source) throw new ApiError(400, "invalid_body", { index, issues: [{ path: "source", message: `must be "${source}"` }] });
    return parsed.data;
  });
  if (new Set(trips.map((t) => t.id)).size !== trips.length) throw new ApiError(400, "invalid_body", "Two trips share an id.");
  const out = store.replaceHistorySource(source, trips);
  if ("conflicts" in out) throw new ApiError(409, "id_taken", { message: "These ids belong to another source's trips.", ids: out.conflicts });
  return { accepted: out.count, removed: out.removed };
});
