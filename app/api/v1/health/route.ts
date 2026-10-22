import { jsonResponse } from "../../../../src/server/http";
import { db } from "../../../../src/server/store";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness for the container healthcheck. Says nothing about the data. */
export function GET() {
  try {
    db().prepare("SELECT 1").get();
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ ok: false }, { status: 503 });
  }
}
