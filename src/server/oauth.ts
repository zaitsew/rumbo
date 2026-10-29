import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject, type webcrypto } from "node:crypto";
import { errorResponse } from "./http";
import { authLockout, clientIp } from "./ratelimit";

/**
 * OAuth 2.1 resource-server side of `/mcp`, so a client that cannot send a static header (a ChatGPT
 * custom connector) can sign in at an authorization server and send its access token. Rumbo is only
 * the resource server (RFC 9728): it publishes where the authorization server is and checks the JWT
 * access token it gets. It issues nothing.
 *
 * Rumbo has one owner, so a valid signature is not enough: the token's `sub` must be the owner's
 * (`RUMBO_OAUTH_OWNER_SUB`). Without it OAuth stays off, because any other account at the same
 * authorization server would otherwise reach the owner's data.
 *
 * The owner key (D5) stays first and unchanged. A bearer value that is not JWT-shaped never reaches
 * this module; a JWT-shaped one is never an owner key (keys are hex or base64url without dots).
 *
 * The seam is `TokenVerifier`. `createJwtVerifier` is the default: signature against the issuer's
 * JWKS, then iss, aud, exp, nbf, sub. Opaque tokens (RFC 7662 introspection) would be another
 * `TokenVerifier`; the accounts hub contract (Fabrique-Futur/accounts, docs/MCP-OAUTH.md) decides
 * which one the hub needs.
 */

type Env = Record<string, string | undefined>;

export interface OAuthConfig {
  /** `iss` the tokens carry, and where the metadata points clients. */
  issuer: string;
  /** Rumbo's MCP URL, the RFC 8707 resource. */
  resource: string;
  /** `aud` values accepted. Defaults to the resource and the site root. */
  audiences: string[];
  /** The one `sub` allowed in. */
  ownerSub: string;
  jwksUrl?: string;
  /** `<site>/.well-known/oauth-protected-resource/mcp`, named in the 401 challenge. */
  metadataUrl: string;
}

export type TokenVerdict = { ok: true; subject: string } | { ok: false; reason: string };

export interface TokenVerifier {
  verify(token: string, now?: Date): Promise<TokenVerdict>;
}

function httpsOrLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname));
  } catch {
    return false;
  }
}

/** OAuth is on only when the issuer, the owner's `sub` and a fixed public URL are all set. */
export function oauthConfig(env: Env = process.env): OAuthConfig | null {
  const issuer = env.RUMBO_OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  const ownerSub = env.RUMBO_OAUTH_OWNER_SUB?.trim();
  const site = env.RUMBO_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!issuer || !ownerSub || !site || !httpsOrLocal(issuer) || !/^https?:\/\/[^\s/]+$/i.test(site)) return null;
  const jwksUrl = env.RUMBO_OAUTH_JWKS_URL?.trim() || undefined;
  if (jwksUrl && !httpsOrLocal(jwksUrl)) return null;
  const resource = `${site}/mcp`;
  const custom = (env.RUMBO_OAUTH_AUDIENCE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    issuer,
    resource,
    audiences: custom.length > 0 ? custom : [resource, site],
    ownerSub,
    ...(jwksUrl ? { jwksUrl } : {}),
    metadataUrl: `${site}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** RFC 9728 document. Public: it names the authorization server and holds no secret. */
export function protectedResourceMetadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Rumbo",
  };
}

// --- JWT access tokens -------------------------------------------------------------------------

const SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

/** Three dot-separated base64url segments: the shape of a JWT, which no owner key has. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Jwk = webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };
const ALGS: Record<string, { kty: string; hash: string; ieee?: boolean }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  ES256: { kty: "EC", hash: "sha256", ieee: true },
};

interface JwksCache {
  keys: Jwk[];
  fetchedAt: number;
}

export function createJwtVerifier(cfg: OAuthConfig, deps: { fetch?: typeof fetch; now?: () => number } = {}): TokenVerifier & { reset(): void } {
  const doFetch = (url: string) => (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "application/json" } });
  const clock = deps.now ?? Date.now;
  let jwksUrl: string | null = cfg.jwksUrl ?? null;
  let cache: JwksCache | null = null;
  const parsed = new Map<string, KeyObject>();

  async function discover(): Promise<string | null> {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      try {
        const res = await doFetch(cfg.issuer + path);
        if (!res.ok) continue;
        const doc = (await res.json()) as { jwks_uri?: unknown };
        if (typeof doc.jwks_uri === "string" && httpsOrLocal(doc.jwks_uri)) return doc.jwks_uri;
      } catch {
        /* try the next document */
      }
    }
    return null;
  }

  async function loadKeys(force: boolean): Promise<Jwk[]> {
    const now = clock();
    if (cache && !force && now - cache.fetchedAt < JWKS_TTL_MS) return cache.keys;
    // A forced refresh (unknown kid) is rate limited, so a stream of junk tokens cannot make Rumbo hammer the issuer.
    if (cache && force && now - cache.fetchedAt < JWKS_REFETCH_MIN_MS) return cache.keys;
    jwksUrl ??= await discover();
    if (!jwksUrl) return cache?.keys ?? [];
    try {
      const res = await doFetch(jwksUrl);
      if (!res.ok) return cache?.keys ?? [];
      const doc = (await res.json()) as { keys?: unknown };
      const keys = Array.isArray(doc.keys) ? (doc.keys as Jwk[]).filter((k) => k && typeof k === "object" && typeof k.kty === "string") : [];
      cache = { keys, fetchedAt: now };
      parsed.clear();
      return keys;
    } catch {
      return cache?.keys ?? [];
    }
  }

  function pick(keys: Jwk[], kid: string | undefined, alg: string): Jwk | null {
    const want = ALGS[alg]!;
    const usable = keys.filter((k) => k.kty === want.kty && (!k.use || k.use === "sig") && (!k.alg || k.alg === alg));
    if (kid !== undefined) return usable.find((k) => k.kid === kid) ?? null;
    return usable.length === 1 ? usable[0]! : null;
  }

  function keyObject(jwk: Jwk): KeyObject | null {
    const id = `${jwk.kid ?? ""}|${jwk.kty}|${jwk.n ?? jwk.x ?? ""}`;
    const hit = parsed.get(id);
    if (hit) return hit;
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      parsed.set(id, key);
      return key;
    } catch {
      return null;
    }
  }

  return {
    reset() {
      cache = null;
      parsed.clear();
      jwksUrl = cfg.jwksUrl ?? null;
    },
    async verify(token, at) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const header = decodeJson(parts[0]!);
      const claims = decodeJson(parts[1]!);
      if (!header || !claims) return { ok: false, reason: "malformed" };
      // Only the two asymmetric algorithms listed. "none" and every HMAC are refused here, before any key is looked at.
      const alg = typeof header.alg === "string" ? header.alg : "";
      if (!Object.hasOwn(ALGS, alg)) return { ok: false, reason: "unsupported_alg" };
      const kid = typeof header.kid === "string" ? header.kid : undefined;

      let jwk = pick(await loadKeys(false), kid, alg);
      if (!jwk) jwk = pick(await loadKeys(true), kid, alg);
      if (!jwk) return { ok: false, reason: "unknown_key" };
      const key = keyObject(jwk);
      if (!key) return { ok: false, reason: "unknown_key" };

      const spec = ALGS[alg]!;
      let good = false;
      try {
        good = cryptoVerify(spec.hash, Buffer.from(`${parts[0]}.${parts[1]}`), spec.ieee ? { key, dsaEncoding: "ieee-p1363" } : key, Buffer.from(parts[2]!, "base64url"));
      } catch {
        good = false;
      }
      if (!good) return { ok: false, reason: "bad_signature" };

      const nowS = Math.floor((at?.getTime() ?? clock()) / 1000);
      if (claims.iss !== cfg.issuer) return { ok: false, reason: "wrong_issuer" };
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.some((a) => typeof a === "string" && cfg.audiences.includes(a))) return { ok: false, reason: "wrong_audience" };
      if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= nowS) return { ok: false, reason: "expired" };
      if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > nowS) return { ok: false, reason: "not_yet_valid" };
      if (typeof claims.sub !== "string" || claims.sub !== cfg.ownerSub) return { ok: false, reason: "not_owner" };
      return { ok: true, subject: claims.sub };
    },
  };
}

// --- the /mcp side -----------------------------------------------------------------------------

const verifiers = new Map<string, TokenVerifier & { reset(): void }>();
function verifierFor(cfg: OAuthConfig): TokenVerifier & { reset(): void } {
  const id = JSON.stringify(cfg);
  let v = verifiers.get(id);
  if (!v) {
    v = createJwtVerifier(cfg);
    verifiers.set(id, v);
  }
  return v;
}

/** For tests: drop every cached verifier and JWKS. */
export function resetOAuthCache(): void {
  for (const v of verifiers.values()) v.reset();
  verifiers.clear();
}

/** The 401 challenge MCP clients follow to find the authorization server (MCP authorization, RFC 9728). */
export function challenge(cfg: OAuthConfig, error?: string): string {
  return `Bearer realm="rumbo"${error ? `, error="${error}"` : ""}, resource_metadata="${cfg.metadataUrl}"`;
}

/**
 * `null` when this request is not an OAuth attempt (OAuth off, no JWT-shaped bearer, or the client is
 * locked out and the owner-key path must answer). Otherwise the verdict: the principal to rate limit
 * on, or the 401. A bad token is not counted toward the owner-key lockout: a JWT cannot be guessed,
 * and an expired one retried by a connector must not lock out a shared address.
 */
export async function authenticateOAuth(
  request: Request,
  cfg: OAuthConfig | null = oauthConfig(),
  verifier?: TokenVerifier,
): Promise<null | { ok: true; principal: string } | { ok: false; response: Response }> {
  if (!cfg) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1]?.trim();
  if (!bearer || !looksLikeJwt(bearer)) return null;
  if (authLockout().locked(clientIp(request.headers))) return null;
  const verdict = await (verifier ?? verifierFor(cfg)).verify(bearer);
  if (verdict.ok) return { ok: true, principal: `oauth:${createHash("sha256").update(verdict.subject).digest("hex").slice(0, 12)}` };
  return {
    ok: false,
    response: errorResponse(401, "invalid_token", `The access token was refused (${verdict.reason}).`, { "WWW-Authenticate": challenge(cfg, "invalid_token") }),
  };
}
