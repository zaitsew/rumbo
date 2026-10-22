"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { allowSignInAttempt, isOwnerKey, ownerKey, safeNextPath } from "../../src/server/auth";
import { clientIp } from "../../src/server/ratelimit";
import { clearSessionCookie, setSessionCookie } from "../../src/server/session";

export async function signInAction(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const fail = (code: string): never => redirect(`/signin?error=${code}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);

  if (!ownerKey()) fail("nokey");
  if (!allowSignInAttempt(clientIp(await headers()))) fail("throttled");
  const key = formData.get("key");
  if (typeof key !== "string" || !isOwnerKey(key.trim())) fail("wrong");

  await setSessionCookie();
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/signin");
}
