import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WatchSchema } from "../../../core/schema";
import { agentName, defineTool, ToolError } from "../tool";

const MAX_WATCHES = 100;

export const tool = defineTool({
  name: "rumbo_watch_add",
  title: "Propose a watch",
  description:
    "Add a search for Rumbo and scheduled agents to keep checking: a route, an anywhere scan, or events, stays or activities in a place. " +
    "It is marked as created by you, and the owner can switch it off or delete it. Add one only when the owner asked for it or it is plainly implied by what they told you; " +
    "you cannot replace a watch the owner made.",
  inputSchema: WatchSchema.omit({ created_by: true, last_run_at: true }).extend({
    id: z.string().min(1).max(60).optional().describe("Only to update a watch you created. Leave out to create a new one."),
    agent: z.string().max(40).optional().describe("Your agent name."),
  }),
  handler: (args, ctx) => {
    const agent = agentName(args.agent, ctx);
    const { agent: _agent, ...fields } = args;
    // New watches get a server-generated id. An id may only name a watch this same agent created.
    const existing = fields.id ? ctx.store.getWatch(fields.id) : null;
    if (fields.id && !existing) throw new ToolError("not_found", `No watch ${fields.id}. Leave out id to create a new watch; the server picks the id.`);
    if (existing && existing.created_by !== agent) {
      throw new ToolError("not_yours", `Watch ${existing.id} was created by ${existing.created_by}. Agents change only their own watches.`);
    }
    if (!existing && ctx.store.listWatches().length >= MAX_WATCHES) {
      throw new ToolError("too_many_watches", `There are already ${MAX_WATCHES} watches. Ask the owner to remove some.`);
    }
    const id = fields.id ?? `w_${randomUUID().slice(0, 8)}`;
    const watch = ctx.store.upsertWatch({ ...fields, id, created_by: agent, ...(existing?.last_run_at ? { last_run_at: existing.last_run_at } : {}) });
    return { watch, created: !existing };
  },
});
