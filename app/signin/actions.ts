"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isOwnerKey, ownerKey, recordSignInFailure, safeNextPath, signInLocked } from "../../src/server/auth";
import { clientIp } from "../../src/server/ratelimit";
import { clearSessionCookie, setSessionCookie } from "../../src/server/session";

export async function signInAction(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const fail = (code: string): never => redirect(`/signin?error=${code}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);

  if (!ownerKey()) fail("nokey");
  const ip = clientIp(await headers());
  if (signInLocked(ip)) fail("throttled"); // before the key is looked at: right or wrong, a locked client is refused
  const key = formData.get("key");
  if (typeof key !== "string" || !isOwnerKey(key.trim())) {
    recordSignInFailure(ip);
    fail("wrong");
  }

  await setSessionCookie();
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/signin");
}
