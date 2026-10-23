import type { Plan } from "../../core/schema";
import { formatMoney } from "../../core/money";
import { planNotices } from "../plan";
import type { Store } from "../store";
import { observationView } from "./format";

/**
 * A plan as an agent reads it: the request, the candidates with the fares sources returned, and the
 * sections with their observations looked up. Every price is an observation's own; nothing is computed here.
 */
export function planView(plan: Plan, store: Store, now: Date) {
  const sections: Record<string, unknown[]> = {};
  const missing: string[] = [];
  for (const key of Object.keys(plan.sections) as (keyof Plan["sections"])[]) {
    sections[key] = [];
    for (const id of plan.sections[key]) {
      const o = store.getObservation(id);
      if (o) sections[key]!.push(observationView(o, now));
      else missing.push(id);
    }
  }
  return {
    id: plan.id,
    status: plan.status,
    created_at: plan.created_at,
    request: plan.request,
    candidates: plan.candidates.map((c) => ({
      place: c.place,
      country: c.country,
      airports: c.airports,
      score: c.score,
      reasons: c.reasons,
      cheapest_flight: c.cheapest_flight
        ? { text: formatMoney(c.cheapest_flight), amount_minor: c.cheapest_flight.amount_minor, currency: c.cheapest_flight.currency, source: c.flight_provenance?.source ?? null, url: c.flight_provenance?.url ?? null, seen_at: c.flight_provenance?.seen_at ?? null }
        : null,
    })),
    chosen: plan.chosen ?? null,
    dates: plan.dates ?? null,
    sections,
    ...(missing.length ? { missing_observations: missing } : {}),
    links: plan.links,
    source_notices: planNotices(store.userId, plan.id, { store }).map((n) => ({ source: n.source, step: n.step, ok: n.ok, calls: n.calls, error: n.error })),
  };
}

export function nextStep(plan: Plan): string {
  if (plan.status === "archived") return "This plan is archived. Start a new one with rumbo_plan_start.";
  if (plan.status === "choosing" || !plan.chosen) {
    return "Ask the owner which place they want, then call rumbo_plan_choose with plan_id and place. Do not choose for them.";
  }
  return "Report the sections as given: prices are sightings from the sources named, not quotes, so check them on the page before anyone books. To hand the plan to Loco, call rumbo_to_loco.";
}
