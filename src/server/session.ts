import { cookies, headers } from "next/headers";
import { authenticate, COOKIE_NAME, sessionCookieOptions, sessionValue, ownerKey } from "./auth";

/** For server components and server actions (route handlers use `authorize` from ./auth). */

export async function isSignedIn(): Promise<boolean> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const cookie = c.get(COOKIE_NAME);
  return authenticate({
    cookie: cookie ? `${COOKIE_NAME}=${cookie.value}` : null,
    authorization: h.get("authorization"),
    host: h.get("host"),
    forwardedFor: h.get("x-forwarded-for"),
  }).ok;
}

/** Throws when the caller is not the owner. Every mutating server action calls it first. */
export async function assertOwner(): Promise<void> {
  if (!(await isSignedIn())) throw new Error("Not signed in.");
}

export async function setSessionCookie(): Promise<void> {
  const key = ownerKey();
  if (!key) throw new Error("RUMBO_OWNER_KEY is not set.");
  (await cookies()).set(COOKIE_NAME, sessionValue(key), sessionCookieOptions());
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}
