import { z } from "zod";
import { PlanError, choosePlace } from "../../plan";
import { nextStep, planView } from "../plan-view";
import { defineTool, ToolError } from "../tool";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const tool = defineTool({
  name: "rumbo_plan_choose",
  title: "Choose a place for a plan",
  hints: { readOnly: false, destructive: true, openWorld: true },
  description:
    "Pick the place the owner chose for a plan and fill its flights, stay, activities and events from the sources, with links for the car. Call it only after the owner named the place; never choose for them. " +
    "The place is one of the plan's candidates or any city by name. Give from and to (YYYY-MM-DD) only if the owner gave dates; otherwise Rumbo uses the cheapest fare found, else the start of the window. " +
    "Nothing is booked. Calling it again for another place replaces the sections.",
  inputSchema: z
    .object({
      plan_id: z.string().min(1).max(60),
      place: z.string().trim().min(1).max(80),
      from: Day.optional().describe("Trip start, if the owner gave dates."),
      to: Day.optional().describe("Trip end, if the owner gave dates."),
    })
    .refine((a) => (a.from === undefined) === (a.to === undefined), { message: "Give both from and to, or neither.", path: ["from"] }),
  handler: async (args, ctx) => {
    try {
      const dates = args.from && args.to ? { from: args.from, to: args.to } : undefined;
      const plan = await choosePlace(ctx.store.userId, args.plan_id, args.place, dates, { store: ctx.store, now: ctx.now });
      return { plan: planView(plan, ctx.store, ctx.now), next: nextStep(plan) };
    } catch (err) {
      if (err instanceof PlanError) throw new ToolError(err.code, err.message);
      throw err;
    }
  },
});
