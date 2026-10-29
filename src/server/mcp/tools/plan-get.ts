import { z } from "zod";
import { nextStep, planView } from "../plan-view";
import { defineTool, ToolError } from "../tool";

export const tool = defineTool({
  name: "rumbo_plan_get",
  title: "Read a trip plan",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description:
    "Read one plan by id, or list the owner's plans when plan_id is left out. A plan has the request, the candidate places with the cheapest fare each source returned, " +
    "and once a place is chosen the flights, stay, activities and events, each with its price, source, link and time seen. It changes nothing. Report prices as given.",
  inputSchema: z.object({
    plan_id: z.string().min(1).max(60).optional().describe("A plan id from rumbo_plan_start. Leave out to list plans."),
    include_archived: z.boolean().optional().describe("When listing, also show archived plans."),
  }),
  handler: (args, ctx) => {
    if (!args.plan_id) {
      const plans = ctx.store.listPlans().filter((p) => args.include_archived || p.status !== "archived");
      return {
        count: plans.length,
        plans: plans.map((p) => ({ id: p.id, status: p.status, created_at: p.created_at, text: p.request.text ?? null, chosen: p.chosen ?? null, dates: p.dates ?? null })),
      };
    }
    const plan = ctx.store.getPlan(args.plan_id);
    if (!plan) throw new ToolError("not_found", `No plan ${args.plan_id}.`);
    return { plan: planView(plan, ctx.store, ctx.now), next: nextStep(plan) };
  },
});
