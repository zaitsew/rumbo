import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorize, keyFromMcpPath } from "../auth";
import { errorResponse, jsonResponse } from "../http";
import { apiLimiter } from "../ratelimit";
import { store } from "../store";
import { createMcpServer } from "./server";
import { cleanAgent } from "./tool";
import { TOOLS } from "./tools";

/**
 * The HTTP side of /mcp and /mcp/<key>. Both go through `authorize()`, so the lockout and the rate
 * limit apply to a key in the path exactly as to a bearer header. The key in a path is a secret: the
 * request handed to the SDK carries a clean URL, and anything printed passes through `redact`.
 */

const MAX_BODY_BYTES = 1_000_000;

/** Removes the key (raw and URL-encoded) from text that is about to be logged or returned. */
export function redact(text: string, key: string | null | undefined): string {
  if (!key) return text;
  let out = text.split(key).join("[redacted]");
  const enc = encodeURIComponent(key);
  if (enc !== key) out = out.split(enc).join("[redacted]");
  return out;
}

function info(): Response {
  return jsonResponse(
    {
      name: "rumbo",
      transport: "Streamable HTTP, stateless: POST JSON-RPC to this URL with Accept: application/json, text/event-stream",
      tools: TOOLS.map((t) => t.name),
      docs: "/llms.txt",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** A request that carries the key as a bearer header, so `authorize()` sees one credential format. */
function withBearer(request: Request, key: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${key}`);
  return new Request("http://rumbo.invalid/mcp", { method: "GET", headers });
}

export async function handleMcp(request: Request, opts: { pathKey?: string } = {}): Promise<Response> {
  const url = new URL(request.url);
  // A key in the path always counts as a credential; one that cannot be decoded counts as a wrong guess.
  const pathKey = opts.pathKey === undefined ? undefined : (keyFromMcpPath(opts.pathKey) ?? "invalid");
  const auth = authorize(pathKey === undefined ? request : withBearer(request, pathKey));
  if (!auth.ok) return auth.response;
  if (!apiLimiter().take(auth.principal)) {
    return errorResponse(429, "rate_limited", "Too many requests. Slow down.", { "Retry-After": "60" });
  }

  if (request.method === "GET" || request.method === "DELETE") return info();
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.", { Allow: "POST" });

  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return errorResponse(413, "body_too_large", `Bodies are limited to ${MAX_BODY_BYTES} bytes.`);
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return errorResponse(413, "body_too_large", `Bodies are limited to ${MAX_BODY_BYTES} bytes.`);

    const headers = new Headers(request.headers);
    headers.delete("authorization"); // not needed past this point; keeps the key out of anything that echoes headers
    const clean = new Request("http://rumbo.invalid/mcp", { method: "POST", headers, body });

    const agent = cleanAgent(request.headers.get("x-rumbo-agent")) ?? cleanAgent(url.searchParams.get("agent"));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer({ store: store(), agent });
    await server.connect(transport);
    try {
      return await transport.handleRequest(clean);
    } finally {
      void server.close().catch(() => undefined);
    }
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : "unknown error", pathKey);
    console.error("[mcp] request failed:", message);
    return errorResponse(500, "internal", "Something went wrong on the server.");
  }
}
