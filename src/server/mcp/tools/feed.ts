import { z } from "zod";
import { ObservationSchema, type ObservationKind } from "../../../core/schema";
import { FEED_MAX_LIMIT, getFeed } from "../../feed";
import { feedItemView } from "../format";
import { defineTool } from "../tool";

export const KINDS = ObservationSchema.options.map((o) => o.shape.kind.value as ObservationKind);

export const tool = defineTool({
  name: "rumbo_feed",
  title: "Ranked travel feed",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description:
    "The owner's ranked travel feed, best first. Each item has a score 0..1, its parts (deal, fit, taste, urgency, novelty) and the reasons behind it, " +
    "computed by Rumbo from observations, profile, history and feedback. Report these numbers as given; never compute or invent your own. " +
    `Optional: limit (default 10, max ${FEED_MAX_LIMIT}) and kinds (flight, stay, car, activity, event, idea).`,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(FEED_MAX_LIMIT).optional().describe("How many items. Default 10."),
    kinds: z.array(z.enum(KINDS as [ObservationKind, ...ObservationKind[]])).optional().describe("Only these kinds."),
  }),
  handler: (args, ctx) => {
    const profile = ctx.store.getProfile();
    const items = getFeed(ctx.store.userId, { limit: args.limit ?? 10, kinds: args.kinds, now: ctx.now }, ctx.store);
    return {
      generated_at: ctx.now.toISOString(),
      count: items.length,
      items: items.map(feedItemView),
      ...(profile ? {} : { note: "No profile yet, so nothing is ranked. Call rumbo_profile_update with home_city and home_airports." }),
    };
  },
});
