import { z } from "zod";
import { PlanRequestSchema } from "../../../core/schema";
import { PlanError, startPlan } from "../../plan";
import { nextStep, planView } from "../plan-view";
import { defineTool, ToolError } from "../tool";

const R = PlanRequestSchema.shape;

export const tool = defineTool({
  name: "rumbo_plan_start",
  title: "Start a trip plan",
  hints: { readOnly: false, destructive: false, openWorld: true },
  description:
    "Start a trip plan from the owner's own words or from fields. A sentence such as \"4 days of kitesurf in December, under 600 euros, with my wife\" works in English, Spanish or Russian: Rumbo reads it, " +
    "ranks places from its destination pool and fetches live fares for the best few; when the sentence names one place it plans that place at once. " +
    "Structured fields win over the sentence. Fares, stays and prices come only from sources Rumbo called; you never supply a price. " +
    "A start makes a few paid-quota source calls, so call it once per request the owner made. Nothing is booked. The answer is the plan: show its candidates, then use rumbo_plan_choose.",
  inputSchema: z
    .object({
      text: z.string().trim().min(1).max(600).optional().describe("The owner's own words about the trip."),
      destination: R.destination.describe("A place the owner already chose."),
      window: R.window.optional().describe("When the trip may happen: { from, to } as YYYY-MM-DD."),
      nights: R.nights.optional().describe("How long: { min, max }."),
      travellers: R.travellers.describe("{ adults, children }. Defaults to the profile."),
      origin: R.origin.describe("IATA codes to fly from. Defaults to the profile's home airports."),
      interests: R.interests.removeDefault().optional(),
      budget_total: R.budget_total.describe("The owner's own budget, in minor units. Never estimate one."),
      needs: R.needs.removeDefault().optional().describe("Any of flights, stay, car, activities, events. Default: all but car."),
    })
    .refine((a) => !!a.text || Object.values(a).some((v) => v !== undefined), { message: "Give text or at least one field." }),
  handler: async (args, ctx) => {
    const { text, ...request } = args;
    try {
      const plan = await startPlan(ctx.store.userId, { text, request }, { store: ctx.store, now: ctx.now });
      return { plan: planView(plan, ctx.store, ctx.now), next: nextStep(plan) };
    } catch (err) {
      if (err instanceof PlanError) throw new ToolError(err.code, err.message);
      throw err;
    }
  },
});
