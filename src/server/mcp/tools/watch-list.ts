import { z } from "zod";
import { isDue } from "../../brief";
import { defineTool } from "../tool";

export const tool = defineTool({
  name: "rumbo_watch_list",
  title: "List watches",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description: "The searches Rumbo keeps checking (routes, anywhere scans, places). Each has `due`: true when it has not run for longer than every_hours. Use rumbo_agent_brief for what to do about the due ones.",
  inputSchema: z.object({}),
  handler: (_args, ctx) => ({
    watches: ctx.store.listWatches().map((w) => ({ ...w, due: isDue(w, ctx.now) })),
  }),
});
