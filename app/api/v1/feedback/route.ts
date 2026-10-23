import { FeedbackSchema } from "../../../../src/core/schema";
import { ApiError, readJson, route } from "../../../../src/server/api";
import { jsonResponse } from "../../../../src/server/http";

export const dynamic = "force-dynamic";

/** ?observation_id=… &since=<ISO instant> */
export const GET = route((req, { store }) => {
  const q = new URL(req.url).searchParams;
  return { feedback: store.listFeedback({ observationId: q.get("observation_id") ?? undefined, since: q.get("since") ?? undefined }) };
});

export const POST = route(async (req, { store }) => {
  const fb = FeedbackSchema.parse(await readJson(req));
  if (!store.getObservation(fb.observation_id)) throw new ApiError(404, "unknown_observation", `No observation ${fb.observation_id}.`);
  return jsonResponse({ feedback: store.addFeedback(fb) }, { status: 201 });
});
