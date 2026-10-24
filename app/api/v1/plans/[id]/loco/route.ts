import { toLocoProposal } from "../../../../../../src/core/loco";
import type { Observation, Plan } from "../../../../../../src/core/schema";
import { ApiError, route } from "../../../../../../src/server/api";
import type { Store } from "../../../../../../src/server/store";

export const dynamic = "force-dynamic";

function proposalArgs(req: Request, id: string, store: Store): { plan: Plan; args: ReturnType<typeof toLocoProposal> } {
  const plan = store.getPlan(id);
  if (!plan) throw new ApiError(404, "not_found", `No plan ${id}.`);
  const q = new URL(req.url).searchParams;
  const observations: Observation[] = [];
  for (const oid of new Set(Object.values(plan.sections).flat())) {
    const o = store.getObservation(oid);
    if (o) observations.push(o);
  }
  const slug = q.get("trip_slug") ?? undefined;
  const tripId = q.get("trip_id") ?? undefined;
  try {
    return { plan, args: toLocoProposal(plan, observations, { ...(slug ? { slug } : {}), ...(tripId ? { id: tripId } : {}) }) };
  } catch (err) {
    throw new ApiError(409, "nothing_to_propose", err instanceof Error ? err.message : String(err));
  }
}

/** ?trip_slug=… or ?trip_id=… The arguments for Loco's loco_propose; the caller makes that call. Nothing is booked or sent. */
export const GET = route<{ id: string }>((req, { params, store }) => ({ loco_propose_args: proposalArgs(req, params.id, store).args }));

/**
 * The same arguments, for the caller that is about to make the loco_propose call (Loco's own server):
 * the plan is marked `sent-to-loco`, so Rumbo's plan page and Loco's list say where it went. Only a
 * `ready` or already sent plan; nothing is booked.
 */
export const POST = route<{ id: string }>((req, { params, store }) => {
  const { plan, args } = proposalArgs(req, params.id, store);
  if (plan.status !== "ready" && plan.status !== "sent-to-loco") {
    throw new ApiError(409, "not_ready", `Plan ${plan.id} is ${plan.status}; choose a place first.`);
  }
  if (plan.status === "ready" && !store.putPlanUnlessArchived({ ...plan, status: "sent-to-loco" })) {
    throw new ApiError(409, "not_ready", `Plan ${plan.id} was archived.`);
  }
  return { loco_propose_args: args, status: "sent-to-loco" };
});
