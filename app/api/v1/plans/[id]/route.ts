import { ApiError, route } from "../../../../../src/server/api";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { params, store }) => {
  const plan = store.getPlan(params.id);
  if (!plan) throw new ApiError(404, "not_found", `No plan ${params.id}.`);
  return { plan };
});
