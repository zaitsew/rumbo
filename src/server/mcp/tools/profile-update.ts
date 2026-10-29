import { z } from "zod";
import { applyProfileUpdate, ProfilePatchSchema } from "../../profile-merge";
import { agentName, defineTool, ToolError } from "../tool";

export const tool = defineTool({
  name: "rumbo_profile_update",
  title: "Add to the owner's profile",
  hints: { readOnly: false, destructive: true, openWorld: false },
  description:
    "Add facts to the owner's profile. `set` is a partial profile: objects merge key by key, lists are unioned, scalars are replaced. " +
    "Nothing is ever removed; the owner removes things on the profile page. `note` is a free-text fact (\"prefers aisle seats\") saved in profile.notes with your name and the time. " +
    "Only record what the owner told you or what is clear from their own data; never infer interests from a single search.",
  inputSchema: z.object({
    set: ProfilePatchSchema.optional().describe("Partial profile without `notes`."),
    note: z.string().min(2).max(500).optional().describe("One fact, kept with provenance."),
    agent: z.string().max(40).optional().describe("Your agent name."),
  }),
  handler: (args, ctx) => {
    const rawSet = ctx.rawArgs.set;
    const hasSet = typeof rawSet === "object" && rawSet !== null && Object.keys(rawSet).length > 0;
    if (!hasSet && !args.note) throw new ToolError("nothing_to_do", "Send `set` with at least one field, or a `note`.");
    const agent = agentName(args.agent, ctx);
    const result = applyProfileUpdate(ctx.store.getProfile(), hasSet ? rawSet : {}, args.note ? { text: args.note, agent, now: ctx.now } : null);
    if (!result.ok) throw new ToolError("invalid_profile", result.error);
    const { profile, changed, notes_added } = result.value;
    if (changed.length > 0) ctx.store.putProfile(profile, ctx.now);
    return { profile, changed, notes_added };
  },
});
