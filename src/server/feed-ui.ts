import { ObservationSchema, type Feedback, type ObservationKind } from "../core/schema";

/** Pure helpers for the feed page, so the filters and the buttons can be tested without a browser. */

export const KIND_FILTERS = ObservationSchema.options.map((o) => o.shape.kind.value as ObservationKind);

/** `?kind=flight` to a kind, or undefined for "all". Anything unknown means all. */
export function parseKindParam(value: string | string[] | undefined): ObservationKind | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return KIND_FILTERS.find((k) => k === v);
}

/** What each button on a feed card records. Like and dislike train the ranker; hide removes the item. */
export const FEEDBACK_BUTTONS = {
  like: { action: "more-like-this", label: "Like", done: "Noted: more like this." },
  dislike: { action: "less-like-this", label: "Dislike", done: "Noted: fewer like this." },
  hide: { action: "dismissed", label: "Hide", done: "Hidden." },
} as const satisfies Record<string, { action: Feedback["action"]; label: string; done: string }>;

export type FeedbackButton = keyof typeof FEEDBACK_BUTTONS;

export function feedbackFromForm(fd: FormData): { ok: true; feedback: Feedback; done: string } | { ok: false; error: string } {
  const id = fd.get("observation_id");
  const button = fd.get("button");
  if (typeof id !== "string" || !id.trim()) return { ok: false, error: "Missing item." };
  if (typeof button !== "string" || !Object.hasOwn(FEEDBACK_BUTTONS, button)) return { ok: false, error: "Unknown button." };
  const b = FEEDBACK_BUTTONS[button as FeedbackButton];
  return { ok: true, feedback: { observation_id: id.trim(), action: b.action }, done: b.done };
}
