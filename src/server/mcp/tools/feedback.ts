import { z } from "zod";
import { FeedbackSchema } from "../../../core/schema";
import { FeedError, recordFeedback } from "../../feed";
import { defineTool, ToolError } from "../tool";

export const tool = defineTool({
  name: "rumbo_feedback",
  title: "React to a feed item",
  hints: { readOnly: false, destructive: false, openWorld: false },
  description:
    "Record the owner's reaction to a feed item: seen, saved, dismissed, booked, more-like-this or less-like-this. " +
    "Call it only when the owner said so; never guess a reaction. A dismissed or booked item leaves the feed.",
  inputSchema: FeedbackSchema.extend({ note: z.string().max(500).optional() }),
  handler: (args, ctx) => {
    try {
      return { feedback: recordFeedback(ctx.store.userId, args, ctx.store, ctx.now) };
    } catch (err) {
      if (err instanceof FeedError) throw new ToolError(err.code, err.message);
      throw err;
    }
  },
});
