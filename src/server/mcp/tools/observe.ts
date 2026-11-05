import { z } from "zod";
import { ObservationSchema } from "../../../core/schema";
import { ingestObservations } from "../../observe";
import { agentName, defineTool } from "../tool";

export const MAX_OBSERVATIONS = 100;

/** The published shape of one row: ObservationSchema with `id` optional, because the server derives it. */
export function observationItemSchema(): Record<string, unknown> {
  const items = z.toJSONSchema(ObservationSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const variants = (items.oneOf ?? items.anyOf) as Record<string, unknown>[] | undefined;
  for (const v of variants ?? [items]) {
    if (Array.isArray(v.required)) v.required = (v.required as string[]).filter((k) => k !== "id");
  }
  return items;
}

export const tool = defineTool({
  name: "rumbo_observe",
  title: "Post observations",
  hints: { readOnly: false, destructive: true, openWorld: false },
  description:
    "Stores observations (flight, stay, car, activity, event, idea) that an agent found. Rows are checked one by one; bad rows come back in `rejected` with the reason and the rest are stored. " +
    "A priced row is accepted with the page it was read on in provenance.url and the time in provenance.seen_at; `id` is optional because the server derives it. " +
    "Each watch named in checked_watch_ids counts as checked, found or not, so it is not due again. rumbo_agent_brief returns the exact shape, one example per kind and the rules. " +
    `A call takes at most ${MAX_OBSERVATIONS} rows. \`accepted\` counts valid rows, of which \`skipped_older\` were not stored because the server already holds a newer sighting.`,
  inputSchema: z.object({
    agent: z.string().min(2).max(40).describe("The agent's name, the same on every run, for example claude-scheduled, codex-automation, chatgpt-task or grok-task."),
    observations: z.array(z.unknown()).max(MAX_OBSERVATIONS),
    checked_watch_ids: z.array(z.string()).max(50).optional().describe("Watches that were searched, found or not."),
  }),
  inputJsonSchema: (generated) => {
    const props = generated.properties as Record<string, Record<string, unknown>> | undefined;
    if (props?.observations) {
      props.observations = { ...props.observations, items: observationItemSchema() };
    }
    return generated;
  },
  handler: (args, ctx) => {
    const agent = agentName(args.agent, ctx);
    return ingestObservations(ctx.store, args.observations, { agent, now: ctx.now, checkedWatchIds: args.checked_watch_ids });
  },
});
