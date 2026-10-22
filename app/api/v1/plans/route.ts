import { route } from "../../../../src/server/api";

export const dynamic = "force-dynamic";

export const GET = route((_req, { store }) => ({ plans: store.listPlans() }));
