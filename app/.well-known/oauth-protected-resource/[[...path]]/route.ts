import { errorResponse, jsonResponse } from "../../../../src/server/http";
import { oauthConfig, protectedResourceMetadata } from "../../../../src/server/oauth";

/**
 * GET /.well-known/oauth-protected-resource[/mcp]: RFC 9728 metadata, so an MCP client that got a 401
 * from /mcp can find the authorization server. Public; 404 while OAuth is not configured, so a
 * deployment that only uses the owner key advertises nothing.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const cfg = oauthConfig();
  if (!cfg) return errorResponse(404, "not_found", "OAuth is not configured on this server.");
  return jsonResponse(protectedResourceMetadata(cfg), { headers: { "Cache-Control": "public, max-age=300" } });
}
