import { ApiError, route } from "../../../../../src/server/api";

export const dynamic = "force-dynamic";

export const DELETE = route<{ id: string }>((_req, { params, store }) => {
  if (!store.deleteWatch(params.id)) throw new ApiError(404, "not_found", `No watch ${params.id}.`);
  return { deleted: params.id };
});
