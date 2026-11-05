import type { Plan } from "../../core/schema";
import { formatMoney } from "../../core/money";
import { planNotices } from "../plan";
import type { Store } from "../store";
import { PRICE_DISCLAIMER, observationView } from "./format";

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
    disclaimer: PRICE_DISCLAIMER,
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

/** Where the plan stands and which tool moves it on, as a statement of fact. */
export function nextStep(plan: Plan): string {
  if (plan.status === "archived") return "This plan is archived; rumbo_plan_start makes a new one.";
  if (plan.status === "choosing" || !plan.chosen) {
    return "No place is chosen yet. The place is the owner's choice; rumbo_plan_choose records it from plan_id and place.";
  }
  return "A place is chosen and the sections hold the sightings, each with its source and time seen. rumbo_to_loco turns the plan into loco_propose arguments.";
}
