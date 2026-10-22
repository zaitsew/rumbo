import { ProfileSchema } from "../../../../src/core/schema";
import { readJson, route } from "../../../../src/server/api";

export const dynamic = "force-dynamic";

export const GET = route((_req, { store }) => ({ profile: store.getProfile() }));

/** Replaces the whole profile. Send the full object; missing fields take their defaults. */
export const PUT = route(async (req, { store }) => {
  const profile = ProfileSchema.parse(await readJson(req));
  return { profile: store.putProfile(profile) };
});
