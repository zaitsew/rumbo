import { handleMcp } from "../../src/server/mcp/http";

/** POST /mcp: stateless Streamable HTTP MCP server. `Authorization: Bearer <owner key>`. */
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleMcp(request);
export const GET = (request: Request) => handleMcp(request);
export const DELETE = (request: Request) => handleMcp(request);
