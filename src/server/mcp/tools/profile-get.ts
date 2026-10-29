import { z } from "zod";
import { defineTool } from "../tool";

export const tool = defineTool({
  name: "rumbo_profile_get",
  title: "Read the owner's profile",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description: "The owner's travel profile: home airports, interests (-2..+2), budgets, free windows, busy days, wishlist and the notes agents added. Null when no profile exists yet.",
  inputSchema: z.object({}),
  handler: (_args, ctx) => {
    const profile = ctx.store.getProfile();
    return profile ? { profile } : { profile: null, note: "No profile yet. Call rumbo_profile_update with home_city and home_airports." };
  },
});
