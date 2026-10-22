import { daysBetween, formatDayRange, formatMoney } from "./money";
import { slug } from "./links";
import type { Money, Observation, Plan } from "./schema";

/**
 * Plan -> the argument object of Loco's `loco_propose` MCP tool (D4: agents propose, people decide).
 *
 * Sources: the tool's input schema in loco/supabase/functions/loco-mcp/core/account-tools.ts and the trip
 * document schema in loco/packages/mcp/src/schema.ts (Stay, Move, Event, Leg, Money, Seen).
 *
 * Mapping
 *   plan                 -> ONE proposal, kind "other", created by "rumbo". `summary` starts with
 *                           "intake:" so Loco shows it as a card in its inbox, one option per booking.
 *   flight observation   -> option with a `move` (mode "air", status "proposed"): the OUTBOUND leg only,
 *                           as in loco_add_options ("one move cannot hold both directions"). A return date
 *                           is named in `details`; the fare is the round-trip price per person.
 *   stay observation     -> option with a `stay`
 *   car observation      -> option with an `event` (category "car", pick-up day), Loco has no rental type
 *   activity / event     -> option with an `event` (category from the tags)
 *   money                -> Loco's Money is MAJOR units (`{amount: 89, currency}`); ours is minor units, so
 *                           amount = amount_minor / 100.
 *   provenance           -> every option carries `seen` {by, at, price, url, note} AND repeats the same facts
 *                           in `details`, because the tool's declared option fields do not list `seen`
 *                           and a strict parse would drop it.
 *   place ids            -> IATA codes (flights: the leg's airports; stays and events: the chosen
 *                           candidate's first airport, else the slugged place name). Loco adds places on
 *                           accept or via loco_add_options `places`; this export does not create them.
 *   status               -> always "proposed". Nothing here is booked, and `who` is [] (Loco fills it).
 */

export interface LocoMoney { amount: number; currency: string }

export interface LocoOption {
  id: string;
  title: string;
  details: string;
  url?: string;
  price?: LocoMoney;
  placeId?: string;
  stay?: Record<string, unknown>;
  move?: Record<string, unknown>;
  event?: Record<string, unknown>;
  seen: { by: "rumbo"; at: string; price?: LocoMoney; url?: string; note?: string };
}

export interface LocoProposeArgs {
  /** Which trip. The caller (an agent holding both connectors) fills one of these. */
  slug?: string;
  id?: string;
  proposal: {
    id: string;
    kind: "other";
    title: string;
    summary: string;
    createdBy: "rumbo";
    options: LocoOption[];
  };
}

const toLoco = (m: Money): LocoMoney => ({ amount: m.amount_minor / 100, currency: m.currency });
const safeId = (id: string): string => `rumbo-${id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}`;

/** Local "HH:mm" and day of an ISO instant that carries its offset. */
const clock = (iso: string): string => iso.slice(11, 16);
const localDay = (iso: string): string => iso.slice(0, 10);

function seenOf(o: Observation, price: Money | undefined, note: string): LocoOption["seen"] {
  const url = o.book_url ?? o.provenance.url;
  return {
    by: "rumbo",
    at: o.provenance.seen_at,
    ...(price ? { price: toLoco(price) } : {}),
    ...(url ? { url } : {}),
    note,
  };
}

function provenanceLine(o: Observation, price: Money | undefined, what: string): string {
  const parts = [`Seen ${o.provenance.seen_at} on ${o.provenance.source}`];
  if (price) parts[0] += `: ${formatMoney(price)} ${what}`;
  if (o.provenance.expires_at) parts.push(`valid until ${o.provenance.expires_at}`);
  return `${parts.join(", ")}. Check the price on the page before booking.`;
}

function eventCategory(o: Observation): string {
  const t = new Set(o.tags);
  if (o.kind === "event") {
    if (t.has("sport-events")) return "sport";
    if (t.has("concerts") || t.has("festivals")) return "show";
    return "other";
  }
  if (t.has("food") || t.has("wine") || t.has("coffee")) return "food";
  if (t.has("nature") || t.has("hiking")) return "nature";
  if (t.has("culture") || t.has("museums") || t.has("city")) return "sight";
  if (t.has("kitesurf") || t.has("surf") || t.has("dive") || t.has("ski") || t.has("cycling") || t.has("running")) return "sport";
  return "other";
}

export function toLocoProposal(plan: Plan, observations: Observation[], trip?: { slug?: string; id?: string }): LocoProposeArgs {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const chosen = plan.candidates.find((c) => c.place === plan.chosen);
  const placeId = chosen?.airports[0] ?? slug(plan.chosen ?? "");
  const options: LocoOption[] = [];
  const seenIds = new Set<string>();

  const ordered: Observation[] = [];
  for (const section of ["flights", "stay", "car", "activities", "events"] as const) {
    for (const oid of plan.sections[section]) {
      const o = byId.get(oid);
      if (o && !seenIds.has(oid)) { seenIds.add(oid); ordered.push(o); }
    }
  }

  for (const o of ordered) {
    const url = o.book_url ?? o.provenance.url;
    const base = { id: safeId(o.id), ...(url ? { url } : {}) };
    switch (o.kind) {
      case "flight": {
        const legs = o.legs.map((l, i) => ({
          id: `${safeId(o.id)}-leg${i + 1}`,
          carrier: l.carrier,
          ...(l.flight_no ? { number: l.flight_no } : {}),
          date: localDay(l.depart_at),
          dep: clock(l.depart_at),
          arr: clock(l.arrive_at),
          arrDayOffset: Math.max(0, daysBetween(localDay(l.depart_at), localDay(l.arrive_at))),
          from: l.from,
          to: l.to,
          fromCode: l.from,
          toCode: l.to,
        }));
        const carrier = o.legs[0]?.carrier ?? o.seller;
        const stops = o.stops === 0 ? "direct" : `${o.stops} ${o.stops === 1 ? "stop" : "stops"}`;
        const ret = o.return_date ? ` Return on ${o.return_date} is part of this fare.` : "";
        const title = `${o.origin} → ${o.destination}, ${formatDayRange(o.depart_date, o.return_date ?? o.depart_date)}`;
        options.push({
          ...base,
          title,
          details: `Flight, ${stops}${carrier ? ` with ${carrier}` : ""}. ${provenanceLine(o, o.price, o.return_date ? "per person, round trip" : "per person")}${ret}`,
          price: toLoco(o.price),
          placeId: o.destination,
          move: {
            id: `${safeId(o.id)}-move`, who: [], date: o.depart_date, mode: "air", status: "proposed",
            fromPlaceId: o.origin, toPlaceId: o.destination, ...(carrier ? { carrier } : {}), legs,
            ...(url ? { url } : {}), price: toLoco(o.price),
          },
          seen: seenOf(o, o.price, `${o.title}${o.seller ? ` via ${o.seller}` : ""}`),
        });
        break;
      }
      case "stay": {
        const nights = Math.max(1, daysBetween(o.check_in, o.check_out));
        options.push({
          ...base,
          title: o.name,
          details: `Stay, ${nights} ${nights === 1 ? "night" : "nights"}${o.rating !== undefined ? `, rated ${o.rating}` : ""}. ${provenanceLine(o, o.price_total, "for the stay")}`,
          price: toLoco(o.price_total),
          placeId,
          stay: {
            id: `${safeId(o.id)}-stay`, placeId, checkIn: o.check_in, checkOut: o.check_out, who: [], status: "proposed",
            name: o.name, platform: o.provenance.source, ...(url ? { url } : {}), price: toLoco(o.price_total),
          },
          seen: seenOf(o, o.price_total, o.title),
        });
        break;
      }
      case "car": {
        options.push({
          ...base,
          title: o.title,
          details: `Car rental from ${o.pickup_date} to ${o.dropoff_date}, pick-up ${o.pickup}. ${provenanceLine(o, o.price_total, "for the rental")}`,
          ...(o.price_total ? { price: toLoco(o.price_total) } : {}),
          placeId,
          event: {
            id: `${safeId(o.id)}-event`, placeId, date: o.pickup_date, who: [], title: o.title, status: "proposed",
            category: "car", venue: o.pickup, ...(url ? { url } : {}), ...(o.price_total ? { price: toLoco(o.price_total) } : {}),
          },
          seen: seenOf(o, o.price_total, o.title),
        });
        break;
      }
      case "activity":
      case "event": {
        const price = o.kind === "activity" ? o.price : o.price_from;
        const date = o.date ?? plan.dates?.from ?? plan.request.window.from;
        options.push({
          ...base,
          title: o.title,
          details: `${o.kind === "event" ? "Event" : "Activity"}${o.date ? ` on ${o.date}` : ""}. ${provenanceLine(o, price, o.kind === "event" ? "from" : "per person")}`,
          ...(price ? { price: toLoco(price) } : {}),
          placeId,
          event: {
            id: `${safeId(o.id)}-event`, placeId, date, who: [], title: o.title, status: "proposed",
            category: eventCategory(o), ...(o.kind === "event" && o.venue ? { venue: o.venue } : {}),
            ...(url ? { url } : {}), ...(price ? { price: toLoco(price) } : {}),
          },
          seen: seenOf(o, price, o.title),
        });
        break;
      }
      case "idea":
        // An idea has no price or dates to commit; it is not an item Loco can accept. Left out.
        break;
    }
  }

  if (options.length === 0) throw new Error("toLocoProposal: the plan has no observations to propose");

  const place = plan.chosen ?? chosen?.place ?? "Trip";
  const span = plan.dates ? formatDayRange(plan.dates.from, plan.dates.to) : formatDayRange(plan.request.window.from, plan.request.window.to);
  return {
    ...(trip?.slug ? { slug: trip.slug } : {}),
    ...(trip?.id ? { id: trip.id } : {}),
    proposal: {
      id: `rumbo-plan-${plan.id}`,
      kind: "other",
      title: `${place}, ${span}`,
      summary: `intake: rumbo · ${options.length} ${options.length === 1 ? "option" : "options"} for ${place}, each with the price and time it was seen`,
      createdBy: "rumbo",
      options,
    },
  };
}
