import { jsonResponse } from "../../../../src/server/http";
import { buildOpenApi } from "../../../../src/server/openapi";
import { siteUrl } from "../../../../src/server/site";

export const dynamic = "force-dynamic";

/** Public, like /llms.txt: it describes the machine surface and holds no data or secret. */
export function GET(request: Request) {
  return jsonResponse(buildOpenApi(siteUrl(request.headers)), { headers: { "Cache-Control": "public, max-age=300" } });
}
