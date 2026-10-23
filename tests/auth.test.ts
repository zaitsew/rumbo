import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authLockout, clientIp, createLockout } from "../src/server/ratelimit";
import {
  COOKIE_NAME,
  authenticate,
  isOwnerKey,
  isValidSession,
  keyFromMcpPath,
  readCookie,
  safeEqual,
  authorize,
  recordSignInFailure,
  safeNextPath,
  signInLocked,
  sessionCookieOptions,
  sessionValue,
} from "../src/server/auth";

const KEY = "correct-horse-battery-staple";
const env = { RUMBO_OWNER_KEY: KEY, NODE_ENV: "test" };

describe("keys and sessions", () => {
  it("compares in constant time and handles different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("stores an HMAC in the cookie, never the key", () => {
    const v = sessionValue(KEY);
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(v).not.toContain(KEY);
    expect(isValidSession(v, env)).toBe(true);
    expect(isValidSession(KEY, env)).toBe(false);
    expect(isValidSession(sessionValue("another-key"), env)).toBe(false);
    expect(isValidSession(v, {})).toBe(false);
  });

  it("checks the owner key", () => {
    expect(isOwnerKey(KEY, env)).toBe(true);
    expect(isOwnerKey("nope", env)).toBe(false);
    expect(isOwnerKey(null, env)).toBe(false);
    expect(isOwnerKey(KEY, {})).toBe(false);
  });

  it("sets httpOnly, lax and secure only in production", () => {
    expect(sessionCookieOptions({ NODE_ENV: "production" })).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(sessionCookieOptions({ NODE_ENV: "development" }).secure).toBe(false);
  });
});

describe("keyFromMcpPath", () => {
  it("decodes the segment", () => {
    expect(keyFromMcpPath("abc%2Bdef")).toBe("abc+def");
    expect(keyFromMcpPath(" k ")).toBe("k");
  });
  it("rejects empty, malformed and oversized segments", () => {
    expect(keyFromMcpPath("")).toBeNull();
    expect(keyFromMcpPath(undefined)).toBeNull();
    expect(keyFromMcpPath("%E0%A4%A")).toBeNull();
    expect(keyFromMcpPath("x".repeat(513))).toBeNull();
  });
});

describe("authenticate", () => {
  it("accepts the bearer key and the session cookie", () => {
    expect(authenticate({ authorization: `Bearer ${KEY}` }, env)).toMatchObject({ ok: true, via: "bearer" });
    expect(authenticate({ authorization: `bearer ${KEY}` }, env)).toMatchObject({ ok: true, via: "bearer" });
    expect(authenticate({ cookie: `a=1; ${COOKIE_NAME}=${sessionValue(KEY)}` }, env)).toMatchObject({ ok: true, via: "cookie" });
  });

  it("refuses a wrong key, a raw key in the cookie and nothing", () => {
    expect(authenticate({ authorization: "Bearer wrong" }, env)).toMatchObject({ ok: false, status: 401, presented: true });
    expect(authenticate({ cookie: `${COOKIE_NAME}=${KEY}` }, env)).toMatchObject({ ok: false, status: 401 });
    expect(authenticate({}, env)).toMatchObject({ ok: false, status: 401, presented: false });
  });

  it("never lets a stale cookie count as a guess", () => {
    expect(authenticate({ cookie: `${COOKIE_NAME}=old` }, env)).toMatchObject({ ok: false, presented: false });
  });

  it("without a key nothing gets in, in any environment, whatever Host or forwarding it claims", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const NODE_ENV of ["production", "development", "test"]) {
      const r = authenticate({ authorization: "Bearer anything" }, { NODE_ENV });
      expect(r).toMatchObject({ ok: false, status: 503, error: "not_configured" });
    }
    expect(authenticate({}, {})).toMatchObject({ ok: false, status: 503 });
    expect(authenticate({ authorization: "Bearer " }, { RUMBO_OWNER_KEY: "   " })).toMatchObject({ ok: false, status: 503 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads a cookie by name", () => {
    expect(readCookie("a=1; b=2", "b")).toBe("2");
    expect(readCookie("ab=1", "b")).toBeNull();
    expect(readCookie(null, "b")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths and drops everything else", () => {
    expect(safeNextPath("/profile")).toBe("/profile");
    expect(safeNextPath("/watches?x=1")).toBe("/watches?x=1");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    // URL parsing strips tabs and newlines, which would turn these into "//evil.example"
    expect(safeNextPath("/\t/evil.example")).toBe("/");
    expect(safeNextPath("/\n/evil.example")).toBe("/");
    expect(safeNextPath("/\r/evil.example")).toBe("/");
    expect(safeNextPath("/ok\u0000")).toBe("/");
    expect(safeNextPath("/\u007f")).toBe("/");
    expect(safeNextPath(" //evil.example")).toBe("/");
    expect(safeNextPath("/a/../../b")).toBe("/b");
    expect(safeNextPath("/profile?x=1#y")).toBe("/profile?x=1#y");
  });
});

describe("lockout", () => {
  it("counts failures per key and globally, and rolls with the window", () => {
    let t = 0;
    const l = createLockout({ perKey: 3, global: 5, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) l.fail("a");
    expect(l.locked("a")).toBe(true);
    expect(l.locked("b")).toBe(false);
    l.fail("b");
    l.fail("c");
    expect(l.locked("d")).toBe(true); // global cap of 5 reached
    t = 1000;
    expect(l.locked("a")).toBe(false);
    expect(l.locked("d")).toBe(false);
  });

  it("believes X-Forwarded-For only behind the trusted proxy, and takes the hop the proxy added", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    expect(clientIp(h, {})).toBe("direct");
    expect(clientIp(h, { RUMBO_TRUST_PROXY: "0" })).toBe("direct");
    expect(clientIp(h, { RUMBO_TRUST_PROXY: "1" })).toBe("203.0.113.9"); // the client cannot choose it
    expect(clientIp(new Headers(), { RUMBO_TRUST_PROXY: "1" })).toBe("direct");
  });
});

describe("authorize: lockout comes before authentication", () => {
  const saved = { key: process.env.RUMBO_OWNER_KEY, trust: process.env.RUMBO_TRUST_PROXY };
  beforeEach(() => {
    process.env.RUMBO_OWNER_KEY = KEY;
    process.env.RUMBO_TRUST_PROXY = "1";
    authLockout().reset();
  });
  afterEach(() => {
    authLockout().reset();
    if (saved.key === undefined) delete process.env.RUMBO_OWNER_KEY;
    else process.env.RUMBO_OWNER_KEY = saved.key;
    if (saved.trust === undefined) delete process.env.RUMBO_TRUST_PROXY;
    else process.env.RUMBO_TRUST_PROXY = saved.trust;
  });
  const req = (ip: string, auth: string) =>
    new Request("http://localhost/api/v1/x", { headers: { authorization: auth, "x-forwarded-for": ip } });

  it("refuses the right key with 429 once the address has used its failures", () => {
    for (let i = 0; i < 10; i++) {
      const r = authorize(req("203.0.113.1", "Bearer wrong"));
      expect(r.ok).toBe(false);
    }
    const locked = authorize(req("203.0.113.1", `Bearer ${KEY}`));
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.response.status).toBe(429);
    // another address is not affected
    expect(authorize(req("203.0.113.2", `Bearer ${KEY}`)).ok).toBe(true);
  });

  it("cannot be dodged by forging the first X-Forwarded-For hop", () => {
    for (let i = 0; i < 10; i++) authorize(req(`1.1.1.${i}, 203.0.113.1`, "Bearer wrong"));
    const r = authorize(req("9.9.9.9, 203.0.113.1", `Bearer ${KEY}`));
    expect(!r.ok && r.response.status).toBe(429);
  });

  it("locks the sign-in form with the same counter", () => {
    for (let i = 0; i < 10; i++) recordSignInFailure("203.0.113.5");
    expect(signInLocked("203.0.113.5")).toBe(true);
    const r = authorize(req("203.0.113.5", `Bearer ${KEY}`));
    expect(!r.ok && r.response.status).toBe(429);
  });

  it("answers 503 not_configured with no key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.RUMBO_OWNER_KEY;
    const r = authorize(req("203.0.113.1", "Bearer x"));
    expect(!r.ok && r.response.status).toBe(503);
    if (!r.ok) expect(await r.response.json()).toMatchObject({ error: "not_configured" });
    warn.mockRestore();
  });
});
