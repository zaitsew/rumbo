"use server";

import { revalidatePath } from "next/cache";
import { FeedError, recordFeedback } from "../../src/server/feed";
import { feedbackFromForm } from "../../src/server/feed-ui";
import { assertOwner } from "../../src/server/session";
import { OWNER } from "../../src/server/store";
import type { FormState } from "./profile/actions";

/** Like, dislike or hide one feed item. The ranker reads the feedback on the next render. */
export async function feedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await assertOwner();
  const parsed = feedbackFromForm(formData);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    recordFeedback(OWNER, parsed.feedback);
  } catch (err) {
    if (err instanceof FeedError) return { ok: false, message: "That item is gone." };
    console.error("[feed] feedback failed", err);
    return { ok: false, message: "Could not save that. Try again." };
  }
  revalidatePath("/");
  return { ok: true, message: parsed.done };
}
