"use server";

import { revalidatePath } from "next/cache";
import { parseProfileForm, parseProfileJson } from "../../../src/server/forms";
import { assertOwner } from "../../../src/server/session";
import { store } from "../../../src/server/store";

export interface FormState {
  ok: boolean;
  message: string;
}

export async function saveProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await assertOwner();
  const s = store();
  const result = parseProfileForm(formData, s.getProfile());
  if (!result.ok) return { ok: false, message: result.error };
  s.putProfile(result.value);
  revalidatePath("/profile");
  return { ok: true, message: "Profile saved." };
}

export async function saveProfileJsonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await assertOwner();
  const raw = formData.get("json");
  const result = parseProfileJson(typeof raw === "string" ? raw : "");
  if (!result.ok) return { ok: false, message: result.error };
  store().putProfile(result.value);
  revalidatePath("/profile");
  return { ok: true, message: "Profile saved from JSON." };
}
