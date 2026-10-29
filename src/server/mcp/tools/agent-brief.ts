import { z } from "zod";
import { buildBrief } from "../../brief";
import { agentName, defineTool } from "../tool";

export const tool = defineTool({
  name: "rumbo_agent_brief",
  title: "What a scheduled run should do now",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description:
    "Call this first in every scheduled run. It returns the due watches turned into concrete searches for the connectors you have, a summary of the owner's profile, " +
    "the exact rumbo_observe shape with one example per kind, and the rules (only report prices you saw with their url and time; never scrape). " +
    "It changes nothing; watches count as checked when you report them in rumbo_observe.",
  inputSchema: z.object({
    agent: z.string().min(2).max(40).describe("Your agent name: claude-scheduled, codex-automation, chatgpt-task, grok-task."),
    connectors: z.array(z.string().max(60)).max(20).optional().describe("The connectors and tools you can use, e.g. [\"Booking.com\", \"Expedia\", \"Viator\", \"Tripadvisor\", \"Kiwi\", \"web search\"]."),
  }),
  handler: (args, ctx) => buildBrief(ctx.store, { agent: agentName(args.agent, ctx), connectors: args.connectors, now: ctx.now }),
});
