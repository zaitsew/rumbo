import { ApiError, route } from "../../../../src/server/api";
import { buildBrief } from "../../../../src/server/brief";
import { cleanAgent } from "../../../../src/server/mcp/tool";

export const dynamic = "force-dynamic";

/** ?agent=grok-task &connectors=Booking.com,Viator. What a scheduled run should do now (the same as the MCP tool rumbo_agent_brief). Changes nothing. */
export const GET = route((req, { store }) => {
  const q = new URL(req.url).searchParams;
  const agent = cleanAgent(q.get("agent")) ?? cleanAgent(req.headers.get("x-rumbo-agent"));
  if (!agent) throw new ApiError(400, "invalid_query", "`agent` is required: 1 to 40 characters from A-Z a-z 0-9 : _ . - (e.g. grok-task).");
  const connectors = q.get("connectors")?.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 20);
  return buildBrief(store, { agent, connectors });
});
