import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateOAuth, createJwtVerifier, looksLikeJwt, oauthConfig, protectedResourceMetadata, type OAuthConfig } from "../src/server/oauth";
import { tempDir } from "./helpers";

const ISSUER = "https://auth.example.com/v1";
const SITE = "https://rumbo.example.com";
const ENV = { RUMBO_OAUTH_ISSUER: ISSUER, RUMBO_OAUTH_OWNER_SUB: "owner-sub", RUMBO_PUBLIC_URL: SITE };
const NOW = 1_800_000_000_000;

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwkOf = (k: KeyObject, kid: string, alg: string) => ({ ...k.export({ format: "jwk" }), kid, use: "sig", alg });
const JWKS = { keys: [jwkOf(rsa.publicKey, "rsa-1", "RS256"), jwkOf(ec.publicKey, "ec-1", "ES256")] };

function claims(over: Record<string, unknown> = {}) {
  return { iss: ISSUER, aud: `${SITE}/mcp`, sub: "owner-sub", exp: NOW / 1000 + 600, ...over };
}
function jwt(payload: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: KeyObject } = {}): string {
  const alg = opts.alg ?? "RS256";
  const head = b64({ alg, typ: "at+jwt", ...(opts.kid === undefined ? { kid: alg === "ES256" ? "ec-1" : "rsa-1" } : { kid: opts.kid }) });
  const input = `${head}.${b64(payload)}`;
  const key = opts.key ?? (alg === "ES256" ? ec.privateKey : rsa.privateKey);
  const sig = alg === "ES256" ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }) : sign("sha256", Buffer.from(input), key);
  return `${input}.${sig.toString("base64url")}`;
}

function fetchStub(jwks: unknown = JWKS) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://auth.example.com/.well-known/oauth-authorization-server/v1") return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (u === `${ISSUER}/jwks`) return Response.json(jwks);
    return new Response("nope", { status: 404 });
  });
}

describe("oauthConfig", () => {
  it("is off unless the issuer, the owner's sub and a fixed public URL are all set", () => {
    expect(oauthConfig({})).toBeNull();
    expect(oauthConfig({ ...ENV, RUMBO_OAUTH_OWNER_SUB: "" })).toBeNull();
    expect(oauthConfig({ ...ENV, RUMBO_PUBLIC_URL: "" })).toBeNull();
    expect(oauthConfig({ ...ENV, RUMBO_OAUTH_ISSUER: "http://auth.example.com" })).toBeNull();
    expect(oauthConfig({ ...ENV, RUMBO_OAUTH_JWKS_URL: "http://evil.example.com/jwks" })).toBeNull();
  });

  it("derives the resource, the audiences and the metadata URL", () => {
    const cfg = oauthConfig({ ...ENV, RUMBO_PUBLIC_URL: `${SITE}/` })!;
    expect(cfg).toMatchObject({ issuer: ISSUER, resource: `${SITE}/mcp`, audiences: [`${SITE}/mcp`, SITE], ownerSub: "owner-sub", metadataUrl: `${SITE}/.well-known/oauth-protected-resource/mcp` });
    expect(oauthConfig({ ...ENV, RUMBO_OAUTH_AUDIENCE: "a, b" })!.audiences).toEqual(["a", "b"]);
    expect(protectedResourceMetadata(cfg)).toEqual({ resource: `${SITE}/mcp`, authorization_servers: [ISSUER], bearer_methods_supported: ["header"], resource_name: "Rumbo" });
  });

  it("keeps the issuer exactly as written, trailing slash included", () => {
    expect(oauthConfig({ ...ENV, RUMBO_OAUTH_ISSUER: `${ISSUER}/` })!.issuer).toBe(`${ISSUER}/`);
  });

  it("tells a JWT from an owner key", () => {
    expect(looksLikeJwt(jwt(claims()))).toBe(true);
    expect(looksLikeJwt("0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(false);
    expect(looksLikeJwt("owner-key-with/odd+chars")).toBe(false);
  });
});

describe("the JWT verifier", () => {
  const cfg = oauthConfig(ENV) as OAuthConfig;
  let fetchMock: ReturnType<typeof fetchStub>;
  let clock: number;
  const make = () => createJwtVerifier(cfg, { fetch: fetchMock as unknown as typeof fetch, now: () => clock });
  beforeEach(() => {
    fetchMock = fetchStub();
    clock = NOW;
  });

  it("accepts the owner's RS256 and ES256 tokens, finding the keys through discovery", async () => {
    const v = make();
    expect(await v.verify(jwt(claims()))).toEqual({ ok: true, subject: "owner-sub" });
    expect(await v.verify(jwt(claims({ aud: [SITE, "other"] }), { alg: "ES256" }))).toEqual({ ok: true, subject: "owner-sub" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // discovery + jwks, once; the second token used the cache
  });

  it("refuses a token for another subject, issuer, audience, or one that has expired", async () => {
    const v = make();
    expect(await v.verify(jwt(claims({ sub: "someone-else" })))).toEqual({ ok: false, reason: "not_owner" });
    expect(await v.verify(jwt(claims({ iss: "https://evil.example.com" })))).toEqual({ ok: false, reason: "wrong_issuer" });
    expect(await v.verify(jwt(claims({ aud: "https://other.example.com/mcp" })))).toEqual({ ok: false, reason: "wrong_audience" });
    expect(await v.verify(jwt(claims({ aud: undefined })))).toEqual({ ok: false, reason: "wrong_audience" });
    expect(await v.verify(jwt(claims({ exp: NOW / 1000 - 120 })))).toEqual({ ok: false, reason: "expired" });
    expect(await v.verify(jwt(claims({ exp: undefined })))).toEqual({ ok: false, reason: "expired" });
    expect(await v.verify(jwt(claims({ nbf: NOW / 1000 + 600 })))).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("refuses a bad signature, a foreign key, a tampered payload, alg none and an HMAC forged with the public key", async () => {
    const v = make();
    expect(await v.verify(jwt(claims(), { key: otherRsa.privateKey }))).toEqual({ ok: false, reason: "bad_signature" });
    const good = jwt(claims());
    const [h, , s] = good.split(".");
    expect(await v.verify(`${h}.${b64(claims({ sub: "someone-else" }))}.${s}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await v.verify(`${b64({ alg: "none" })}.${b64(claims())}.`)).toEqual({ ok: false, reason: "unsupported_alg" });
    const pem = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;
    const input = `${b64({ alg: "HS256", kid: "rsa-1" })}.${b64(claims())}`;
    const forged = `${input}.${createHmac("sha256", pem).update(input).digest("base64url")}`;
    expect(await v.verify(forged)).toEqual({ ok: false, reason: "unsupported_alg" });
    expect(await v.verify("a.b.c")).toEqual({ ok: false, reason: "malformed" });
  });

  it("refetches the keys once for an unknown kid, then not again for a minute", async () => {
    const v = make();
    expect(await v.verify(jwt(claims()))).toMatchObject({ ok: true });
    const before = fetchMock.mock.calls.length;
    expect(await v.verify(jwt(claims(), { kid: "unknown" }))).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetchMock.mock.calls.length).toBe(before); // inside the minute: no refetch
    clock += 61_000;
    expect(await v.verify(jwt(claims({ exp: clock / 1000 + 600 }), { kid: "unknown" }))).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("picks up a rotated key", async () => {
    const v = make();
    await v.verify(jwt(claims()));
    const fresh = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fetchMock.mockImplementation(fetchStub({ keys: [...JWKS.keys, jwkOf(fresh.publicKey, "rsa-2", "RS256")] }) as never);
    clock += 61_000;
    expect(await v.verify(jwt(claims({ exp: clock / 1000 + 600 }), { kid: "rsa-2", key: fresh.privateKey }))).toEqual({ ok: true, subject: "owner-sub" });
  });

  it("accepts an issuer whose iss ends in a slash", async () => {
    const slash = oauthConfig({ ...ENV, RUMBO_OAUTH_ISSUER: `${ISSUER}/` }) as OAuthConfig;
    const v = createJwtVerifier(slash, { fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    expect(await v.verify(jwt(claims({ iss: `${ISSUER}/` })))).toEqual({ ok: true, subject: "owner-sub" });
    expect(await v.verify(jwt(claims({ iss: ISSUER })))).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("finds the JWKS through the RFC 8414 path-inserted document", async () => {
    fetchMock.mockImplementation((async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://auth.example.com/.well-known/oauth-authorization-server/v1") return Response.json({ jwks_uri: "https://auth.example.com/keys" });
      if (u === "https://auth.example.com/keys") return Response.json(JWKS);
      return new Response("nope", { status: 404 });
    }) as never);
    expect(await make().verify(jwt(claims()))).toEqual({ ok: true, subject: "owner-sub" });
  });

  it("does not hit a failing issuer more than once a minute", async () => {
    fetchMock.mockImplementation((async () => new Response("down", { status: 503 })) as never);
    const v = make();
    expect(await v.verify(jwt(claims()))).toEqual({ ok: false, reason: "unknown_key" });
    const calls = fetchMock.mock.calls.length;
    for (let i = 0; i < 5; i++) expect(await v.verify(jwt(claims()))).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetchMock.mock.calls.length).toBe(calls);
    clock += 61_000;
    await v.verify(jwt(claims({ exp: clock / 1000 + 600 })));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("refuses when the issuer cannot be reached", async () => {
    fetchMock.mockImplementation((async () => {
      throw new Error("down");
    }) as never);
    expect(await make().verify(jwt(claims()))).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("authenticateOAuth", () => {
  it("leaves an owner key that looks like a JWT to the owner-key path", async () => {
    const before = process.env.RUMBO_OWNER_KEY;
    process.env.RUMBO_OWNER_KEY = "aaa.bbb.ccc";
    try {
      const cfg = oauthConfig(ENV);
      const req = (t: string) => new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${t}` } });
      expect(await authenticateOAuth(req("aaa.bbb.ccc"), cfg)).toBeNull();
      expect(await authenticateOAuth(req("aaa.bbb.zzz"), cfg, { verify: async () => ({ ok: false, reason: "x" }) })).toMatchObject({ ok: false });
    } finally {
      if (before === undefined) delete process.env.RUMBO_OWNER_KEY;
      else process.env.RUMBO_OWNER_KEY = before;
    }
  });
});

describe("/mcp and the metadata route with OAuth on", () => {
  const OWNER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tmp = tempDir();
  const saved = { ...process.env };
  type Route = { POST: (r: Request) => Promise<Response> };
  let mcp: Route;
  let meta: { GET: () => Response };
  let oauth: typeof import("../src/server/oauth");
  let closeDb: () => void;
  const post = (token: string | null) =>
    mcp.POST(new Request("http://localhost:3000/mcp", { method: "POST", headers: { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), "x-forwarded-for": "9.9.9.9" }, body }));

  beforeAll(async () => {
    Object.assign(process.env, { RUMBO_DB: tmp.path, RUMBO_OWNER_KEY: OWNER_KEY, RUMBO_TRUST_PROXY: "1", ...ENV });
    vi.resetModules();
    mcp = (await import("../app/mcp/route")) as unknown as Route;
    meta = (await import("../app/.well-known/oauth-protected-resource/[[...path]]/route")) as unknown as typeof meta;
    oauth = await import("../src/server/oauth");
    closeDb = (await import("../src/server/store")).closeDb;
  });
  afterAll(() => {
    closeDb();
    tmp.cleanup();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  beforeEach(() => {
    oauth.resetOAuthCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub() as never);
    (globalThis as unknown as { __rumboLimiters?: Record<string, { reset(): void }> }).__rumboLimiters?.lockout?.reset();
  });
  afterEach(() => vi.restoreAllMocks());

  const live = () => jwt(claims({ exp: Date.now() / 1000 + 600 }));

  it("serves the metadata, and 404s when OAuth is off", async () => {
    const res = meta.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [ISSUER] });
    const issuer = process.env.RUMBO_OAUTH_ISSUER;
    delete process.env.RUMBO_OAUTH_ISSUER;
    expect(meta.GET().status).toBe(404);
    process.env.RUMBO_OAUTH_ISSUER = issuer;
  });

  it("lets the owner's access token in, and the owner key still works", async () => {
    const ok = await post(live());
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.tools).toHaveLength(13);
    expect((await post(OWNER_KEY)).status).toBe(200);
  });

  it("points an unauthenticated client at the metadata", async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer realm="rumbo", resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`);
    const wrongKey = await post("a-wrong-owner-key");
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("refuses another account's token with invalid_token, and does not count it toward the key lockout", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await post(jwt(claims({ sub: "someone-else", exp: Date.now() / 1000 + 600 })));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid_token");
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    expect((await post(OWNER_KEY)).status).toBe(200); // not locked out
  });
});
