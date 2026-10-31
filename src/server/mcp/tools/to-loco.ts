import { z } from "zod";
import { toLocoProposal } from "../../../core/loco";
import type { Observation } from "../../../core/schema";
import { defineTool, ToolError } from "../tool";

export const tool = defineTool({
  name: "rumbo_to_loco",
  title: "Plan as a Loco proposal",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description:
    "Turn a Rumbo plan into the arguments for Loco's loco_propose tool. Rumbo does not call Loco and nothing is booked: you call loco_propose yourself with `loco_propose_args`, " +
    "and the people on the trip decide. Pass trip_slug or trip_id of the Loco trip it belongs to.",
  inputSchema: z.object({
    plan_id: z.string().min(1),
    trip_slug: z.string().optional(),
    trip_id: z.string().optional(),
  }),
  handler: (args, ctx) => {
    const plan = ctx.store.getPlan(args.plan_id);
    if (!plan) throw new ToolError("not_found", `No plan ${args.plan_id}.`);
    const ids = new Set(Object.values(plan.sections).flat());
    const observations: Observation[] = [];
    for (const id of ids) {
      const o = ctx.store.getObservation(id);
      if (o) observations.push(o);
    }
    const trip = { ...(args.trip_slug ? { slug: args.trip_slug } : {}), ...(args.trip_id ? { id: args.trip_id } : {}) };
    // A plan that was just started has nothing to propose yet. That is the caller's state, not a server fault.
    let proposal: ReturnType<typeof toLocoProposal>;
    try {
      proposal = toLocoProposal(plan, observations, trip);
    } catch {
      throw new ToolError("nothing_to_propose", "This plan has no saved flights, stays or activities to propose yet. Choose options with rumbo_plan_choose first.");
    }
    return {
      loco_propose_args: proposal,
      next: "Call Loco's loco_propose with loco_propose_args. Check the prices on the pages before anyone books; they are sightings, not quotes.",
      missing_observations: [...ids].filter((id) => !observations.some((o) => o.id === id)),
    };
  },
});
