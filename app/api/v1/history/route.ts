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
