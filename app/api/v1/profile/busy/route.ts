import { ApiError, readJson, route } from "../../../../../src/server/api";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = { loco: "Loco" };

/**
 * `?source=loco` and a body that is that source's WHOLE list of busy windows `[{from, to, what?}]`:
 * the windows it owns (their `what` ends with " (Loco)") are replaced, the owner's own stay (D8).
 * An empty array clears them. Answers the profile's busy list after the change.
 */
export const PUT = route(async (req, { store }) => {
  const source = new URL(req.url).searchParams.get("source") ?? "";
  const label = LABELS[source];
  if (!label) throw new ApiError(400, "invalid_source", `Pass ?source= one of: ${Object.keys(LABELS).join(", ")}.`);
  const body = await readJson(req);
  if (!Array.isArray(body)) throw new ApiError(400, "invalid_body", "Send an array of {from, to, what?}.");
  if (body.length > 500) throw new ApiError(413, "too_many", "At most 500 windows.");
  if (!store.getProfile()) throw new ApiError(409, "no_profile", "Set up the profile first.");
  return store.replaceBusySource(label, body);
});
