"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseChooseForm, parsePlanForm } from "../../../src/server/plan-forms";
import { PlanError, archivePlan, choosePlace, startPlan } from "../../../src/server/plan";
import { assertOwner } from "../../../src/server/session";
import { OWNER, store } from "../../../src/server/store";
import type { FormState } from "../profile/actions";

function message(err: unknown): string {
  if (err instanceof PlanError) return err.message;
  console.error("[plan] unexpected", err);
  return "Something went wrong while planning. Nothing was booked; try again.";
}

export async function startPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await assertOwner();
  const parsed = parsePlanForm(formData, store().getProfile()?.currency ?? "EUR");
  if (!parsed.ok) return { ok: false, message: parsed.error };
  let id: string;
  try {
    id = (await startPlan(OWNER, parsed.value)).id;
  } catch (err) {
    return { ok: false, message: message(err) };
  }
  revalidatePath("/plan");
  redirect(`/plan/${id}`); // outside the try: redirect() works by throwing
}

export async function choosePlaceAction(formData: FormData): Promise<void> {
  await assertOwner();
  const parsed = parseChooseForm(formData);
  if (!parsed.ok) redirect(`/plan/${encodeURIComponent(String(formData.get("id") ?? ""))}?error=${encodeURIComponent(parsed.error)}`);
  const { id, place, dates } = parsed.value;
  let error = "";
  try {
    await choosePlace(OWNER, id, place, dates);
  } catch (err) {
    error = message(err);
  }
  revalidatePath(`/plan/${id}`);
  redirect(error ? `/plan/${encodeURIComponent(id)}?error=${encodeURIComponent(error)}` : `/plan/${encodeURIComponent(id)}`);
}

export async function archivePlanAction(formData: FormData): Promise<void> {
  await assertOwner();
  const id = String(formData.get("id") ?? "");
  try {
    archivePlan(OWNER, id);
  } catch (err) {
    console.error("[plan] archive failed", err);
  }
  revalidatePath("/plan");
  redirect("/plan");
}
