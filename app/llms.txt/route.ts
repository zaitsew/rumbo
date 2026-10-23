import { buildLlmsTxt } from "../../src/server/llms";
import { siteUrl } from "../../src/server/site";

export const dynamic = "force-dynamic";

/** Public description of Rumbo for agents. Holds no data and no secret. */
export function GET(request: Request) {
  return new Response(buildLlmsTxt(siteUrl(request.headers)), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
