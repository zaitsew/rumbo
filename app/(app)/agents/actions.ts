"use server";

import { ownerKey } from "../../../src/server/auth";
import { assertOwner } from "../../../src/server/session";

export type RevealResult = { ok: true; key: string } | { ok: false; message: string };

/** Returns the owner key to a signed-in owner who clicked Reveal. Never rendered into the page itself. */
export async function revealKeyAction(): Promise<RevealResult> {
  try {
    await assertOwner();
  } catch {
    return { ok: false, message: "Sign in again." };
  }
  const key = ownerKey();
  if (!key) return { ok: false, message: "RUMBO_OWNER_KEY is not set on the server." };
  return { ok: true, key };
}
