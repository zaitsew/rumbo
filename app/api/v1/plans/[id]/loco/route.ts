import { toLocoProposal } from "../../../../../../src/core/loco";
import type { Observation } from "../../../../../../src/core/schema";
import { ApiError, route } from "../../../../../../src/server/api";

export const dynamic = "force-dynamic";

/** ?trip_slug=… or ?trip_id=… The arguments for Loco's loco_propose; the caller makes that call. Nothing is booked or sent. */
export const GET = route<{ id: string }>((req, { params, store }) => {
  const plan = store.getPlan(params.id);
  if (!plan) throw new ApiError(404, "not_found", `No plan ${params.id}.`);
  const q = new URL(req.url).searchParams;
  const observations: Observation[] = [];
  for (const id of new Set(Object.values(plan.sections).flat())) {
    const o = store.getObservation(id);
    if (o) observations.push(o);
  }
  const slug = q.get("trip_slug") ?? undefined;
  const tripId = q.get("trip_id") ?? undefined;
  return { loco_propose_args: toLocoProposal(plan, observations, { ...(slug ? { slug } : {}), ...(tripId ? { id: tripId } : {}) }) };
});
