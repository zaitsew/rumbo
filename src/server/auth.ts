import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { errorResponse } from "./http";
import { authLockout, clientIp } from "./ratelimit";

/**
 * Access is one owner key (D5). `RUMBO_OWNER_KEY` gates the site, the API and MCP.
 *  - The web sign-in stores an HMAC of the key in an httpOnly cookie, never the key.
 *  - API and MCP clients send `Authorization: Bearer <key>`.
 *  - Claude and ChatGPT connectors cannot send a header, so `/mcp/<key>` is accepted too
 *    (`keyFromMcpPath`). That URL is a secret; rotating the key changes it.
 *  - No key, in any environment: nothing gets in. There is no localhost exemption, because Host and
 *    X-Forwarded-For are client-controlled and a dev server can be reached from the network.
 *  - Failures are counted per client address (see `clientIp`) and checked BEFORE credentials, so a
 *    locked-out client is refused with 429 even when it sends the right key.
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

let warned = false;
/** Printed once, on the first request that finds no key. */
export function warnNoKey(): void {
  if (warned) return;
  warned = true;
  const bar = "!".repeat(72);
  console.warn(
    `\n${bar}\n  RUMBO_OWNER_KEY is not set. Every page and API route refuses all requests.\n` +
      `  Set it in .env (openssl rand -hex 24) and restart.\n${bar}\n`,
  );
}

export interface AuthInput {
  /** The raw `Cookie` header. */
  cookie?: string | null;
  /** The raw `Authorization` header. */
  authorization?: string | null;
}

export type AuthResult =
  | { ok: true; via: "cookie" | "bearer"; principal: string }
  | { ok: false; status: 401 | 503; error: string; detail: string; presented: boolean };

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Pure decision: who is this request? `presented` is true when it carried a wrong credential. */
export function authenticate(input: AuthInput, env: Env = process.env): AuthResult {
  const key = ownerKey(env);
  if (!key) {
    warnNoKey();
    return { ok: false, status: 503, error: "not_configured", detail: "RUMBO_OWNER_KEY is not set on this server. Set it in .env and restart.", presented: false };
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
  };
}

export type Authorized = { ok: true; principal: string } | { ok: false; response: Response };

/**
 * For API routes: the owner's principal, or the response to return. The lockout is asked first, so
 * a locked-out client never reaches the credential check. A wrong bearer key counts as a failure.
 */
export function authorize(request: Request): Authorized {
  const ip = clientIp(request.headers);
  const lock = authLockout();
  if (ownerKey() && lock.locked(ip)) {
    return { ok: false, response: errorResponse(429, "too_many_attempts", "Too many wrong keys. Wait ten minutes.", { "Retry-After": "600" }) };
  }
  const result = authenticate(authInputFrom(request));
  if (result.ok) return { ok: true, principal: result.principal };
  if (result.presented) lock.fail(ip);
  return { ok: false, response: errorResponse(result.status, result.error, result.detail, result.status === 401 ? { "WWW-Authenticate": 'Bearer realm="rumbo"' } : undefined) };
}

/** `null` when the request is the owner's; otherwise the 401/429/503 response to return. */
export function requireOwner(request: Request): Response | null {
  const a = authorize(request);
  return a.ok ? null : a.response;
}

/** Sign-in asks this before looking at the key. */
export function signInLocked(ip: string): boolean {
  return authLockout().locked(ip);
}

/** A wrong key on the sign-in form. */
export function recordSignInFailure(ip: string): void {
  authLockout().fail(ip);
}

/**
 * Only same-site paths survive. The value is rejected when it holds a control character (tab and
 * newline are stripped by URL parsing, so "/\t/evil.example" would become "//evil.example") or a
 * backslash, then resolved against a dummy origin: it must stay on that origin and keep a single
 * leading slash. Anything else becomes "/".
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    const u = new URL(value, "http://x");
    if (u.origin !== "http://x" || !u.pathname.startsWith("/") || u.pathname.startsWith("//")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
