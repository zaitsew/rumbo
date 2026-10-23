"use client";

import { useActionState } from "react";
import { feedbackAction } from "../app/(app)/actions";
import type { FormState } from "../app/(app)/profile/actions";
import { FEEDBACK_BUTTONS, type FeedbackButton } from "../src/server/feed-ui";

const INITIAL: FormState = { ok: false, message: "" };
const ORDER: FeedbackButton[] = ["like", "dislike", "hide"];

/** Like / dislike / hide for one feed item. One form, three submit buttons; the answer is read out politely. */
export function FeedActions({ observationId, title }: { observationId: string; title: string }) {
  const [state, action, pending] = useActionState(feedbackAction, INITIAL);
  return (
    <form action={action} className="feed-actions">
      <input type="hidden" name="observation_id" value={observationId} />
      <div className="row">
        {ORDER.map((b) => (
          <button key={b} type="submit" name="button" value={b} className="btn btn-sm" disabled={pending} aria-label={`${FEEDBACK_BUTTONS[b].label}: ${title}`}>
            {FEEDBACK_BUTTONS[b].label}
          </button>
        ))}
        <span role="status" aria-live="polite" className={`t-caption ${state.ok ? "muted" : "feed-error"}`}>
          {state.message}
        </span>
      </div>
    </form>
  );
}
