import { formatMoney } from "../../core/money";
import type { FeedItem, Money, Observation } from "../../core/schema";

/** Compact views of feed items for agents: the facts and the reasons, not the whole row. */

export function headlinePrice(o: Observation): Money | undefined {
  switch (o.kind) {
    case "flight": case "activity": return o.price;
    case "stay": case "car": return o.price_total;
    case "event": return o.price_from;
    default: return undefined;
  }
}

export function datesOf(o: Observation): Record<string, string> | undefined {
  switch (o.kind) {
    case "flight": return { depart: o.depart_date, ...(o.return_date ? { return: o.return_date } : {}) };
    case "stay": return { check_in: o.check_in, check_out: o.check_out };
    case "car": return { pickup: o.pickup_date, dropoff: o.dropoff_date };
    case "activity": return o.date ? { date: o.date } : undefined;
    case "event": return { date: o.date, ...(o.end_date ? { end: o.end_date } : {}) };
    case "idea": return o.when ? { from: o.when.from, to: o.when.to } : undefined;
  }
}

export function feedItemView(i: FeedItem) {
  const o = i.observation;
  const price = headlinePrice(o);
  return {
    id: o.id,
    kind: o.kind,
    title: o.title,
    place: o.place,
    country: o.country ?? null,
    tags: o.tags,
    price: price ? { text: formatMoney(price), amount_minor: price.amount_minor, currency: price.currency } : null,
    dates: datesOf(o) ?? null,
    url: o.book_url ?? o.provenance.url ?? null,
    source: o.provenance.source,
    agent: o.provenance.agent ?? null,
    seen_at: o.provenance.seen_at,
    expires_at: o.provenance.expires_at ?? null,
    score: i.score,
    parts: i.parts,
    reasons: i.reasons,
    ...(i.why ? { why: i.why } : {}),
    stale: i.stale,
    state: i.state,
  };
}

/** A compact view of one stored observation, for plan sections: the facts, the price and where it came from. */
export function observationView(o: Observation, now: Date) {
  const price = headlinePrice(o);
  const expires = o.provenance.expires_at;
  return {
    id: o.id,
    kind: o.kind,
    title: o.title,
    place: o.place,
    price: price ? { text: formatMoney(price), amount_minor: price.amount_minor, currency: price.currency } : null,
    dates: datesOf(o) ?? null,
    url: o.book_url ?? o.provenance.url ?? null,
    source: o.provenance.source,
    seen_at: o.provenance.seen_at,
    expires_at: expires ?? null,
    stale: !!expires && Date.parse(expires) <= now.getTime(),
  };
}
