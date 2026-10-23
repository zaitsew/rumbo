import { randomUUID } from "node:crypto";
import { WatchSchema } from "../../../../src/core/schema";
import { ApiError, readJson, route } from "../../../../src/server/api";
import { jsonResponse } from "../../../../src/server/http";

export const dynamic = "force-dynamic";

export const GET = route((_req, { store }) => ({ watches: store.listWatches() }));

/** Creates a watch, or replaces the one with the same `id`. `id` is generated when missing. */
export const POST = route(async (req, { store }) => {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "invalid_body", "Send one watch object.");
  const raw = body as Record<string, unknown>;
  const watch = WatchSchema.parse({ ...raw, id: typeof raw.id === "string" && raw.id ? raw.id : `w_${randomUUID().slice(0, 8)}` });
  return jsonResponse({ watch: store.upsertWatch(watch) }, { status: 201 });
});
