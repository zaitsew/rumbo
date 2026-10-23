import { ProfileSchema } from "../../../../src/core/schema";
import { ApiError, readJson, route } from "../../../../src/server/api";
import { cleanAgent } from "../../../../src/server/mcp/tool";
import { applyProfileUpdate } from "../../../../src/server/profile-merge";

export const dynamic = "force-dynamic";

export const GET = route((_req, { store }) => ({ profile: store.getProfile() }));

/** Replaces the whole profile. Send the full object; missing fields take their defaults. */
export const PUT = route(async (req, { store }) => {
  const profile = ProfileSchema.parse(await readJson(req));
  return { profile: store.putProfile(profile) };
});

/**
 * Body: `{ set?: partial profile, note?: string, agent?: string }` (the same as the MCP tool
 * rumbo_profile_update). Merges and never removes: objects merge, lists union, scalars replace;
 * `note` is appended to profile.notes with the agent's name and the time.
 */
export const PATCH = route(async (req, { store }) => {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "invalid_body", "Send an object with `set` and/or `note`.");
  const b = body as { set?: unknown; note?: unknown; agent?: unknown };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  const hasSet = typeof b.set === "object" && b.set !== null && Object.keys(b.set).length > 0;
  if (!hasSet && !note) throw new ApiError(400, "nothing_to_do", "Send `set` with at least one field, or a `note`.");
  const agent = cleanAgent(typeof b.agent === "string" ? b.agent : null) ?? cleanAgent(req.headers.get("x-rumbo-agent")) ?? "agent";
  const now = new Date();
  const result = applyProfileUpdate(store.getProfile(), hasSet ? b.set : {}, note ? { text: note, agent, now } : null);
  if (!result.ok) throw new ApiError(400, "invalid_profile", result.error);
  if (result.value.changed.length > 0) store.putProfile(result.value.profile, now);
  return { profile: result.value.profile, changed: result.value.changed, notes_added: result.value.notes_added };
});
