import { route } from "../../../../src/server/api";
import { collectDue } from "../../../../src/server/collect";

export const dynamic = "force-dynamic";

/** Owner auth. Runs every watch that is due and says what it found. The droplet's scheduler calls it hourly. */
export const POST = route(async (_req, { store }) => collectDue(store.userId, new Date(), { store }));
