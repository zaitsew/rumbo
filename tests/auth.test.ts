import { describe, expect, it, vi } from "vitest";
import {
  COOKIE_NAME,
  authenticate,
  isLocalRequest,
  isOwnerKey,
  isValidSession,
  keyFromMcpPath,
  readCookie,
  safeEqual,
  safeNextPath,
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

  it("without a key: production refuses all, development allows only localhost", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(authenticate({ host: "localhost:3000" }, { NODE_ENV: "production" })).toMatchObject({ ok: false, status: 503 });
    expect(authenticate({ host: "localhost:3000" }, { NODE_ENV: "development" })).toMatchObject({ ok: true, via: "local-dev" });
    expect(authenticate({ host: "rumbo.example.com" }, { NODE_ENV: "development" })).toMatchObject({ ok: false, status: 401 });
    expect(authenticate({ host: "localhost:3000", forwardedFor: "1.2.3.4" }, { NODE_ENV: "development" })).toMatchObject({ ok: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("knows local hosts", () => {
    expect(isLocalRequest("localhost:3000")).toBe(true);
    expect(isLocalRequest("127.0.0.1")).toBe(true);
    expect(isLocalRequest("[::1]:3000")).toBe(true);
    expect(isLocalRequest("localhost.evil.com")).toBe(false);
    expect(isLocalRequest("localhost:3000", "::1")).toBe(true); // what next dev adds itself
    expect(isLocalRequest("localhost:3000", "::ffff:127.0.0.1")).toBe(true);
    expect(isLocalRequest("localhost:3000", "127.0.0.1, 203.0.113.9")).toBe(false); // a proxy appended a visitor
    expect(isLocalRequest(null)).toBe(false);
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
  });
});
