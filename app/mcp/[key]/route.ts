import { handleMcp } from "../../../src/server/mcp/http";

/**
 * POST /mcp/<owner key>: the same server for Claude.ai and ChatGPT custom connectors, which cannot send
 * a header. The URL is the secret. It goes through the same lockout and rate limit as the bearer form.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };
const handle = async (request: Request, { params }: Ctx) => handleMcp(request, { pathKey: (await params).key });

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
