import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { errorResponse } from "./http";
import { authFailLimiter, clientIp } from "./ratelimit";

/**
 * Access is one owner key (D5). `RUMBO_OWNER_KEY` gates the site, the API and MCP.
 *  - The web sign-in stores an HMAC of the key in an httpOnly cookie, never the key.
 *  - API and MCP clients send `Authorization: Bearer <key>`.
 *  - Claude and ChatGPT connectors cannot send a header, so `/mcp/<key>` is accepted too
 *    (`keyFromMcpPath`). That URL is a secret; rotating the key changes it.
 *  - No key in development: a loud warning, and only localhost gets in. No key in production:
 *    nothing gets in.
 */

export const COOKIE_NAME = "rumbo_session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
const SESSION_LABEL = "rumbo-session-v1";

type Env = Record<string, string | undefined>;

export function ownerKey(env: Env = process.env): string | null {
  const key = env.RUMBO_OWNER_KEY?.trim();
  return key ? key : null;
}

/** Constant-time string comparison: both sides are hashed first, so length does not leak. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** What the cookie holds: an HMAC keyed by the owner key. Changing the key signs everyone out. */
export function sessionValue(key: string): string {
  return createHmac("sha256", key).update(SESSION_LABEL).digest("hex");
}

export function isOwnerKey(candidate: string | null | undefined, env: Env = process.env): boolean {
  const key = ownerKey(env);
  return !!key && !!candidate && safeEqual(candidate, key);
}

export function isValidSession(cookieValue: string | null | undefined, env: Env = process.env): boolean {
  const key = ownerKey(env);
  return !!key && !!cookieValue && safeEqual(cookieValue, sessionValue(key));
}

/** The key as written in an `/mcp/<key>` URL segment, decoded; null when it is empty or absurd. */
export function keyFromMcpPath(segment: string | null | undefined): string | null {
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  decoded = decoded.trim();
  return decoded && decoded.length <= 512 ? decoded : null;
}

export function sessionCookieOptions(env: Env = process.env) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  };
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A host header is local when it names this machine; a forwarded request never counts. */
export function isLocalRequest(host: string | null | undefined, forwardedFor?: string | null): boolean {
  if (forwardedFor) return false;
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

let warned = false;
function warnNoKey(): void {
  if (warned) return;
  warned = true;
  const bar = "!".repeat(72);
  console.warn(
    `\n${bar}\n  RUMBO_OWNER_KEY is not set. Development mode: only localhost is allowed in.\n` +
      `  Set it in .env (openssl rand -hex 24) before exposing this server.\n${bar}\n`,
  );
}

export interface AuthInput {
  /** The raw `Cookie` header. */
  cookie?: string | null;
  /** The raw `Authorization` header. */
  authorization?: string | null;
  host?: string | null;
  forwardedFor?: string | null;
}

export type AuthResult =
  | { ok: true; via: "cookie" | "bearer" | "local-dev"; principal: string }
  | { ok: false; status: 401 | 503; error: string; detail: string; presented: boolean };

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Pure decision: who is this request? `presented` is true when it carried a wrong credential. */
export function authenticate(input: AuthInput, env: Env = process.env): AuthResult {
  const key = ownerKey(env);
  if (!key) {
    if (env.NODE_ENV === "production") {
      return { ok: false, status: 503, error: "owner_key_not_set", detail: "RUMBO_OWNER_KEY is not set on this server.", presented: false };
    }
    warnNoKey();
    if (isLocalRequest(input.host, input.forwardedFor)) return { ok: true, via: "local-dev", principal: "local-dev" };
    return { ok: false, status: 401, error: "unauthorized", detail: "No owner key is set; only localhost is allowed.", presented: false };
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(input.authorization?.trim() ?? "")?.[1]?.trim();
  if (bearer && safeEqual(bearer, key)) return { ok: true, via: "bearer", principal: fingerprint(key) };

  const cookie = readCookie(input.cookie, COOKIE_NAME);
  if (cookie && safeEqual(cookie, sessionValue(key))) return { ok: true, via: "cookie", principal: fingerprint(key) };

  return {
    ok: false,
    status: 401,
    error: "unauthorized",
    detail: "Send `Authorization: Bearer <RUMBO_OWNER_KEY>` or sign in at /signin.",
    presented: !!bearer, // a stale cookie after a key rotation must not lock the browser out
  };
}

export function authInputFrom(request: Request): AuthInput {
  const h = request.headers;
  return {
    cookie: h.get("cookie"),
    authorization: h.get("authorization"),
    host: h.get("host") ?? new URL(request.url).host,
    forwardedFor: h.get("x-forwarded-for"),
  };
}

export type Authorized = { ok: true; principal: string } | { ok: false; response: Response };

/** For API routes: the owner's principal, or the response to return. Wrong credentials are throttled per address. */
export function authorize(request: Request): Authorized {
  const ip = clientIp(request.headers);
  const result = authenticate(authInputFrom(request));
  if (result.ok) return { ok: true, principal: result.principal };
  if (result.presented && !authFailLimiter().take(ip)) {
    return { ok: false, response: errorResponse(429, "too_many_attempts", "Too many wrong keys from this address. Wait ten minutes.", { "Retry-After": "600" }) };
  }
  return { ok: false, response: errorResponse(result.status, result.error, result.detail, result.status === 401 ? { "WWW-Authenticate": 'Bearer realm="rumbo"' } : undefined) };
}

/** `null` when the request is the owner's; otherwise the 401/429/503 response to return. */
export function requireOwner(request: Request): Response | null {
  const a = authorize(request);
  return a.ok ? null : a.response;
}

/** Throttle sign-in attempts. Returns false when this address has used its attempts. */
export function allowSignInAttempt(ip: string): boolean {
  return authFailLimiter().take(`signin:${ip}`);
}
