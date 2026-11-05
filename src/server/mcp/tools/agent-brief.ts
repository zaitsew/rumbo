import { z } from "zod";
import { buildBrief } from "../../brief";
import { agentName, defineTool } from "../tool";

export const tool = defineTool({
  name: "rumbo_agent_brief",
  title: "Scheduled run brief",
  hints: { readOnly: true, destructive: false, openWorld: false },
  description:
    "Returns the brief for one agent's scheduled run: the due watches turned into concrete searches for the connectors the agent declares, a summary of the owner's profile, " +
    "the exact rumbo_observe shape with one example per kind, and the rules the server applies (a price is stored with the page it was read on and the time it was seen). " +
    "It changes nothing; a watch counts as checked when rumbo_observe names it.",
  inputSchema: z.object({
    agent: z.string().min(2).max(40).describe("The agent's name, for example claude-scheduled, codex-automation, chatgpt-task or grok-task."),
    connectors: z.array(z.string().max(60)).max(20).optional().describe("The connectors and tools the agent has, for example [\"Booking.com\", \"Expedia\", \"Viator\", \"Tripadvisor\", \"Kiwi\", \"web search\"]."),
  }),
  handler: (args, ctx) => buildBrief(ctx.store, { agent: agentName(args.agent, ctx), connectors: args.connectors, now: ctx.now }),
});
