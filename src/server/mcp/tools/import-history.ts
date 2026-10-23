import { z } from "zod";
import { PastTripSchema } from "../../../core/schema";
import { defineTool } from "../tool";

const MAX_TRIPS = 200;

export const tool = defineTool({
  name: "rumbo_import_history",
  title: "Import past trips",
  description:
    "Save past trips so Rumbo knows where the owner has been and what they rated. For an agent that holds Loco's connector: call loco_list_trips and loco_get_trip, " +
    "map each trip to {id, title, from, to, places[], rating?, tags[]} and send them here. Trips are upserted by id; nothing is removed. " +
    `Rows are checked one by one. At most ${MAX_TRIPS} per call. Tags must be from the interest list (beach, city, ski, food, ...).`,
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
