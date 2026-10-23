import { z } from "zod";
import { ProfileSchema, type Profile } from "../core/schema";

/**
 * What an agent may change in the profile (D4: propose, never delete). `set` is a partial profile
 * without `notes` (facts go through `note`, with provenance). Merge rules, applied to the keys the
 * caller actually sent:
 *   - objects merge key by key (`interests`, `budget`, `flight`, ...),
 *   - lists are unioned: existing items stay, new ones are appended,
 *   - scalars are replaced.
 * No key and no list item is ever removed; the owner removes things on /profile.
 */

export const ProfilePatchSchema = ProfileSchema.omit({ notes: true }).partial().strict();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function mergeValue(current: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) {
    const base = Array.isArray(current) ? [...current] : [];
    for (const item of patch) if (!base.some((b) => same(b, item))) base.push(item);
    return base;
  }
  if (isObj(patch)) {
    const base = isObj(current) ? { ...current } : {};
    for (const [k, v] of Object.entries(patch)) base[k] = mergeValue(base[k], v);
    return base;
  }
  return patch;
}

export interface ProfileUpdate {
  profile: Profile;
  /** Top-level keys whose value changed. */
  changed: string[];
  notes_added: number;
}

export type ProfileUpdateResult = { ok: true; value: ProfileUpdate } | { ok: false; error: string };

/**
 * `rawSet` is the object exactly as the caller sent it: the parsed copy has every default filled in,
 * and merging that would overwrite the owner's values with defaults.
 */
export function applyProfileUpdate(
  current: Profile | null,
  rawSet: unknown,
  note: { text: string; agent: string; now: Date } | null,
): ProfileUpdateResult {
  const checked = ProfilePatchSchema.safeParse(rawSet ?? {});
  if (!checked.success) {
    return { ok: false, error: checked.error.issues.map((i) => `${i.path.join(".") || "set"}: ${i.message}`).join("; ") };
  }
  const sent = isObj(rawSet) ? Object.keys(rawSet) : [];
  const base: Record<string, unknown> = current ? { ...current } : {};
  const changed: string[] = [];
  for (const key of sent) {
    const before = base[key];
    const after = mergeValue(before, (rawSet as Record<string, unknown>)[key]);
    if (!same(before, after)) changed.push(key);
    base[key] = after;
  }

  let notesAdded = 0;
  const text = note?.text.trim();
  if (note && text) {
    const notes = Array.isArray(base.notes) ? [...(base.notes as Profile["notes"])] : [];
    if (!notes.some((n) => n.text.trim().toLowerCase() === text.toLowerCase())) {
      notes.push({ text, provenance: { source: "agent", agent: note.agent, seen_at: note.now.toISOString() } });
      notesAdded = 1;
      changed.push("notes");
    }
    base.notes = notes;
  }

  const merged = ProfileSchema.safeParse(base);
  if (!merged.success) {
    const missing = current ? "" : " There is no profile yet, so `set` must include home_city and home_airports.";
    return { ok: false, error: merged.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ") + missing };
  }
  return { ok: true, value: { profile: merged.data, changed, notes_added: notesAdded } };
}
