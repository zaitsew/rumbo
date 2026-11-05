import { z } from "zod";
import { PastTripSchema } from "../../../core/schema";
import { defineTool } from "../tool";

const MAX_TRIPS = 200;

export const tool = defineTool({
  name: "rumbo_import_history",
  title: "Import past trips",
  hints: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
  description:
    "Saves past trips so Rumbo knows where the owner has been and what they rated. An agent that holds Loco's connector can map the results of loco_list_trips and loco_get_trip " +
    "to {id, title, from, to, places[], rating?, tags[]} and send them here. Trips are upserted by id; nothing is removed. " +
    `Rows are checked one by one. A call takes at most ${MAX_TRIPS} trips. Tags come from the interest list (beach, city, ski, food, ...).`,
  inputSchema: z.object({ trips: z.array(z.unknown()).max(MAX_TRIPS) }),
  inputJsonSchema: (generated) => {
    const props = generated.properties as Record<string, Record<string, unknown>> | undefined;
    if (props?.trips) props.trips = { ...props.trips, items: z.toJSONSchema(PastTripSchema, { io: "input", unrepresentable: "any" }) };
    return generated;
  },
  handler: (args, ctx) => {
    const valid: z.infer<typeof PastTripSchema>[] = [];
    const rejected: { index: number; error: string }[] = [];
    args.trips.forEach((t, index) => {
      const r = PastTripSchema.safeParse(t);
      if (r.success) valid.push(r.data);
      else rejected.push({ index, error: r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`).join("; ") });
    });
    const { count } = ctx.store.upsertHistory(valid);
    return { accepted: count, rejected };
  },
});
