import { NextResponse, type NextRequest } from "next/server";
import { authenticate } from "./src/server/auth";

/**
 * Pages need the owner's session; everything else is checked where it is served:
 * /api and /mcp check the key themselves, /signin is how you get one, and /llms.txt,
 * /openapi.json and static assets are public descriptions of the machine surface.
 */
export function proxy(request: NextRequest) {
  const h = request.headers;
  const auth = authenticate({
    cookie: h.get("cookie"),
    authorization: h.get("authorization"),
    host: h.get("host"),
    forwardedFor: h.get("x-forwarded-for"),
  });
  if (auth.ok) return undefined; // continue

  // Next wants an absolute URL. Behind Caddy the container sees http, so take the scheme and host
  // the visitor used from the forwarded headers rather than from the internal request URL.
  const { pathname, search } = request.nextUrl;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(":", "");
  const host = h.get("host") || request.nextUrl.host;
  const next = pathname === "/" && !search ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  const res = NextResponse.redirect(new URL(`/signin${next}`, `${proto}://${host}`));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  matcher: ["/((?!api(?:/|$)|mcp(?:/|$)|signin(?:/|$)|_next/|llms\\.txt$|llms-full\\.txt$|openapi\\.json$|icon\\.svg$|favicon\\.ico$|robots\\.txt$).*)"],
};
