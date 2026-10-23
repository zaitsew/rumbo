"use server";

import { revalidatePath } from "next/cache";
import { parseWatchForm } from "../../../src/server/forms";
import { assertOwner } from "../../../src/server/session";
import { store } from "../../../src/server/store";
import type { FormState } from "../profile/actions";

export async function addWatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await assertOwner();
  const s = store();
  const result = parseWatchForm(formData, s.getProfile()?.currency ?? "EUR");
  if (!result.ok) return { ok: false, message: result.error };
  s.upsertWatch(result.value);
  revalidatePath("/watches");
  return { ok: true, message: `Added "${result.value.label}".` };
}

export async function toggleWatchAction(formData: FormData): Promise<void> {
  await assertOwner();
  const s = store();
  const watch = s.getWatch(String(formData.get("id") ?? ""));
  if (!watch) return;
  s.upsertWatch({ ...watch, active: !watch.active });
  revalidatePath("/watches");
}

export async function deleteWatchAction(formData: FormData): Promise<void> {
  await assertOwner();
  store().deleteWatch(String(formData.get("id") ?? ""));
  revalidatePath("/watches");
}
