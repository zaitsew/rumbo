import { z } from "zod";
import { applyProfileUpdate, ProfilePatchSchema } from "../../profile-merge";
import { agentName, defineTool, ToolError } from "../tool";

export const tool = defineTool({
  name: "rumbo_profile_update",
  title: "Add to the owner's profile",
  hints: { readOnly: false, destructive: true, openWorld: false },
  description:
    "Adds facts to the owner's profile. `set` is a partial profile: objects merge key by key, lists are unioned, scalars are replaced. " +
    "Nothing is removed; the owner removes things on the profile page. `note` is a free-text fact (\"prefers aisle seats\") saved in profile.notes with the agent's name and the time.",
  inputSchema: z.object({
    set: ProfilePatchSchema.optional().describe("Partial profile without `notes`."),
    note: z.string().min(2).max(500).optional().describe("One fact, kept with provenance."),
    agent: z.string().max(40).optional().describe("The agent's name."),
  }),
  handler: (args, ctx) => {
    const rawSet = ctx.rawArgs.set;
    const hasSet = typeof rawSet === "object" && rawSet !== null && Object.keys(rawSet).length > 0;
    if (!hasSet && !args.note) throw new ToolError("nothing_to_do", "The call has no `set` fields and no `note`; either one is accepted.");
    const agent = agentName(args.agent, ctx);
    const result = applyProfileUpdate(ctx.store.getProfile(), hasSet ? rawSet : {}, args.note ? { text: args.note, agent, now: ctx.now } : null);
    if (!result.ok) throw new ToolError("invalid_profile", result.error);
    const { profile, changed, notes_added } = result.value;
    if (changed.length > 0) ctx.store.putProfile(profile, ctx.now);
    return { profile, changed, notes_added };
  },
});
