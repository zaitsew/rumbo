import type { Destination } from "./destinations";
import { norm } from "./destinations";
import { daysBetween, formatDayRange, formatDuration, formatMoney, medianInt, monthName, msToDay } from "./money";
import type { Feedback, FeedItem, Interest, Observation, PastTrip, Profile, ScoreParts, Watch } from "./schema";

/**
 * Ranking: `score = 0.35·deal + 0.25·fit + 0.20·taste + 0.10·urgency + 0.10·novelty`, each part 0..1.
 * Deterministic, pure, no I/O. The AI never writes a number (D3): every figure in a reason is read from
 * an observation, the profile, the history, or computed from them (a difference, a median, a count of days).
 *
 * Mapping from the observation kinds:
 *   flight    deal against the median of the same route (same month if 3+ exist), else the same place
 *   stay      price per night against profile.budget.night_max and against other stays in the place
 *   car       per day against other cars in the place
 *   activity  price against other activities in the place
 *   event/idea no price comparison: deal is neutral (0.4)
 *
 * Deviations from the architecture sketch, all additive:
 *   - `ctx.watches` is optional; a price under a watch's `max_price` adds a deal bonus.
 *   - A baseline needs at least MIN_BASELINE other observations; below that the deal is neutral (0.4).
 *   - Past-dated and stale items stay in the feed with `stale: true`, `deal = 0`.
 */

export const WEIGHTS = { deal: 0.35, fit: 0.25, taste: 0.2, urgency: 0.1, novelty: 0.1 } as const;

/** Tunables, exported so tests and tuning have one place to look. */
export const TUNING = {
  neutralDeal: 0.4,
  minBaseline: 2, // other observations needed before a median counts as "the usual price"
  sameMonthMin: 3, // route observations in the same month needed to use the month baseline
  watchBonus: 0.25,
  staleFlightHours: 48,
  staleOtherDays: 7,
  urgentDepartureDays: 30,
  urgentExpiryHours: 72,
  dismissPlaceKindDays: 30,
  dismissPlaceKindFactor: 0.5,
  tagFeedbackDays: 90,
  recentVisitDays: 365,
  recentVisitTastePenalty: 0.25,
  loveRatingFloor: 4,
} as const;

export interface RankFeedback {
  observation_id: string;
  action: Feedback["action"];
  at: string; // ISO instant
}

export interface RankContext {
  profile: Profile;
  history: PastTrip[];
  feedback: RankFeedback[];
  now: Date;
  destinations?: Destination[];
  /** Optional: lets a price under a watch's `max_price` earn a bonus. */
  watches?: Watch[];
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// --- date helpers ---------------------------------------------------------------------------------

interface Range { from: string; to: string }

function rangeOf(o: Observation): Range | null {
  switch (o.kind) {
    case "flight": return { from: o.depart_date, to: o.return_date ?? o.depart_date };
    case "stay": return { from: o.check_in, to: o.check_out };
    case "car": return { from: o.pickup_date, to: o.dropoff_date };
    case "activity": return o.date ? { from: o.date, to: o.date } : null;
    case "event": return { from: o.date, to: o.end_date ?? o.date };
    case "idea": return o.when ? { from: o.when.from, to: o.when.to } : null;
  }
}

const overlaps = (a: Range, b: Range): boolean => a.from <= b.to && b.from <= a.to;
const inside = (a: Range, b: Range): boolean => a.from >= b.from && a.to <= b.to;

function priceOf(o: Observation): { amount_minor: number; currency: string } | null {
  switch (o.kind) {
    case "flight": return o.price;
    case "stay": return o.price_total;
    case "car": return o.price_total ?? null;
    case "activity": return o.price ?? null;
    case "event": return o.price_from ?? null;
    case "idea": return null;
  }
}

function nightsOf(o: { check_in: string; check_out: string }): number {
  return Math.max(1, daysBetween(o.check_in, o.check_out));
}

// --- staleness ------------------------------------------------------------------------------------

function isStale(o: Observation, now: Date): boolean {
  const today = msToDay(now.getTime());
  const r = rangeOf(o);
  if (r && r.to < today) return true; // already over
  if (o.kind === "flight" && o.depart_date < today) return true;
  const p = o.provenance;
  if (p.expires_at) return Date.parse(p.expires_at) < now.getTime();
  const age = now.getTime() - Date.parse(p.seen_at);
  const limit = o.kind === "flight" ? TUNING.staleFlightHours * HOUR : TUNING.staleOtherDays * DAY;
  return age > limit;
}

// --- dedupe ---------------------------------------------------------------------------------------

/**
 * What makes two flight observations the same flight: the same legs (flight number or carrier, route and
 * departure instant). Without legs the only facts to compare are the number of stops, so a direct flight
 * and a connecting one are never merged.
 */
function flightSignature(o: Extract<Observation, { kind: "flight" }>): string {
  if (o.legs.length === 0) return `stops${o.stops}`;
  return o.legs
    .map((l) => `${norm(l.flight_no ?? l.carrier).replace(/\s+/g, "")}:${l.from}-${l.to}@${Date.parse(l.depart_at)}`)
    .join(">");
}

function dedupeKey(o: Observation): string {
  const place = norm(o.place);
  switch (o.kind) {
    case "flight": return `flight|${o.origin}|${o.destination}|${o.depart_date}|${o.return_date ?? ""}|${flightSignature(o)}`;
    case "stay": return `stay|${place}|${norm(o.name)}|${o.check_in}|${o.check_out}`;
    case "car": return `car|${place}|${norm(o.pickup)}|${o.pickup_date}|${o.dropoff_date}`;
    case "activity": return `activity|${place}|${norm(o.title)}|${o.date ?? ""}`;
    case "event": return `event|${place}|${norm(o.title)}|${o.date}`;
    case "idea": return `idea|${place}|${norm(o.title)}`;
  }
}

interface Group { winner: Observation; members: Observation[]; stale: boolean }

function groupDuplicates(observations: Observation[], now: Date): Group[] {
  const byKey = new Map<string, Observation[]>();
  for (const o of observations) {
    const k = dedupeKey(o);
    const arr = byKey.get(k);
    if (arr) arr.push(o); else byKey.set(k, [o]);
  }
  const groups: Group[] = [];
  for (const members of byKey.values()) {
    const live = members.filter((m) => !isStale(m, now));
    const pool = live.length ? live : members;
    const winner = [...pool].sort((a, b) => {
      const pa = priceOf(a);
      const pb = priceOf(b);
      // Same currency: cheapest first. Otherwise (or no price) the freshest.
      if (pa && pb && pa.currency === pb.currency && pa.amount_minor !== pb.amount_minor) return pa.amount_minor - pb.amount_minor;
      return Date.parse(b.provenance.seen_at) - Date.parse(a.provenance.seen_at) || a.id.localeCompare(b.id);
    })[0]!;
    groups.push({ winner, members, stale: isStale(winner, now) });
  }
  return groups;
}

// --- baselines ------------------------------------------------------------------------------------

interface Baseline { amount_minor: number; label: string }

function flightBaseline(o: Extract<Observation, { kind: "flight" }>, pool: Observation[]): Baseline | null {
  const others = pool.filter(
    (x): x is Extract<Observation, { kind: "flight" }> =>
      x.kind === "flight" && x.id !== o.id && x.price.currency === o.price.currency && dedupeKey(x) !== dedupeKey(o) &&
      // A one-way fare and a round-trip fare are different products: never compare across.
      Boolean(x.return_date) === Boolean(o.return_date),
  );
  const route = others.filter((x) => x.origin === o.origin && x.destination === o.destination);
  const month = o.depart_date.slice(0, 7);
  const sameMonth = route.filter((x) => x.depart_date.slice(0, 7) === month);
  if (sameMonth.length >= TUNING.sameMonthMin) {
    return { amount_minor: medianInt(sameMonth.map((x) => x.price.amount_minor)), label: `${o.origin}–${o.destination} fare` };
  }
  if (route.length >= TUNING.minBaseline) {
    return { amount_minor: medianInt(route.map((x) => x.price.amount_minor)), label: `${o.origin}–${o.destination} fare` };
  }
  const place = others.filter((x) => norm(x.place) === norm(o.place));
  if (place.length >= TUNING.minBaseline) {
    return { amount_minor: medianInt(place.map((x) => x.price.amount_minor)), label: `fare to ${o.place}` };
  }
  return null;
}

/** Per-night (stays) or per-day (cars) or per-item (activities) baseline in the same place and kind. */
function placeBaseline(o: Observation, pool: Observation[], unitPrice: (x: Observation) => number | null, currency: string): Baseline | null {
  const others = pool.filter(
    (x) => x.kind === o.kind && x.id !== o.id && norm(x.place) === norm(o.place) && dedupeKey(x) !== dedupeKey(o) && priceOf(x)?.currency === currency,
  );
  const vals = others.map(unitPrice).filter((v): v is number => v !== null);
  if (vals.length < TUNING.minBaseline) return null;
  return { amount_minor: medianInt(vals), label: o.kind === "stay" ? `${o.place} stay` : o.kind === "car" ? `${o.place} car rental` : `${o.place} activity` };
}

// --- per-part scoring -----------------------------------------------------------------------------

/** price/baseline -> 0..1: equal = 0.5, 20% under or better = 1, 20% over or worse = 0. */
const ratioScore = (price: number, baseline: number): number =>
  baseline > 0 ? clamp01(0.5 + (1 - price / baseline) * 2.5) : TUNING.neutralDeal;

interface Scored { value: number; reasons: string[] }

function scoreDeal(o: Observation, stale: boolean, pool: Observation[], ctx: RankContext): Scored {
  const reasons: string[] = [];
  if (stale) return { value: 0, reasons };
  const price = priceOf(o);
  if (!price) return { value: TUNING.neutralDeal, reasons };

  let value: number | null = null;

  if (o.kind === "flight") {
    const b = flightBaseline(o, pool);
    if (b && b.amount_minor > 0) {
      value = ratioScore(price.amount_minor, b.amount_minor);
      const saving = b.amount_minor - price.amount_minor;
      if (saving > 0 && price.amount_minor <= b.amount_minor * 0.95) {
        reasons.push(`${formatMoney({ amount_minor: saving, currency: price.currency })} under the usual ${b.label}`);
      }
    }
  } else if (o.kind === "stay") {
    const nights = nightsOf(o);
    const perNight = Math.round(o.price_total.amount_minor / nights);
    const parts: number[] = [];
    const cap = ctx.profile.budget.night_max;
    if (cap && cap.amount_minor > 0 && cap.currency === price.currency) {
      // 60% of the cap or less = 1, the cap = 0.6, 130% or more = 0.
      const r = perNight / cap.amount_minor;
      parts.push(clamp01(r <= 0.6 ? 1 : r <= 1 ? 1 - ((r - 0.6) / 0.4) * 0.4 : 0.6 - ((r - 1) / 0.3) * 0.6));
      if (perNight <= cap.amount_minor) {
        reasons.push(`${formatMoney({ amount_minor: perNight, currency: price.currency })} a night, within your ${formatMoney(cap)} budget`);
      }
    }
    const b = placeBaseline(o, pool, (x) => (x.kind === "stay" ? Math.round(x.price_total.amount_minor / nightsOf(x)) : null), price.currency);
    if (b && b.amount_minor > 0) {
      parts.push(ratioScore(perNight, b.amount_minor));
      const saving = b.amount_minor - perNight;
      if (saving > 0 && perNight <= b.amount_minor * 0.95) {
        reasons.push(`${formatMoney({ amount_minor: saving, currency: price.currency })} a night under the usual ${b.label}`);
      }
    }
    if (parts.length) value = parts.reduce((a, c) => a + c, 0) / parts.length;
  } else if (o.kind === "car") {
    const days = Math.max(1, daysBetween(o.pickup_date, o.dropoff_date));
    const perDay = Math.round(price.amount_minor / days);
    const b = placeBaseline(o, pool, (x) => (x.kind === "car" && x.price_total ? Math.round(x.price_total.amount_minor / Math.max(1, daysBetween(x.pickup_date, x.dropoff_date))) : null), price.currency);
    if (b && b.amount_minor > 0) {
      value = ratioScore(perDay, b.amount_minor);
      const saving = b.amount_minor - perDay;
      if (saving > 0 && perDay <= b.amount_minor * 0.95) {
        reasons.push(`${formatMoney({ amount_minor: saving, currency: price.currency })} a day under the usual ${b.label}`);
      }
    }
  } else if (o.kind === "activity") {
    const b = placeBaseline(o, pool, (x) => (x.kind === "activity" ? x.price?.amount_minor ?? null : null), price.currency);
    if (b && b.amount_minor > 0) {
      value = ratioScore(price.amount_minor, b.amount_minor);
      const saving = b.amount_minor - price.amount_minor;
      if (saving > 0 && price.amount_minor <= b.amount_minor * 0.95) {
        reasons.push(`${formatMoney({ amount_minor: saving, currency: price.currency })} under the usual ${b.label}`);
      }
    }
  }

  let deal = value ?? TUNING.neutralDeal;

  // A price under a watch's alert level earns a bonus.
  if (o.watch_id) {
    const w = ctx.watches?.find((x) => x.id === o.watch_id);
    if (w?.max_price && w.max_price.currency === price.currency && price.amount_minor <= w.max_price.amount_minor) {
      deal = Math.min(1, deal + TUNING.watchBonus);
      reasons.push(`under your ${formatMoney(w.max_price)} limit for "${w.label}"`);
    }
  }
  return { value: clamp01(deal), reasons };
}

interface Memory {
  visited: Map<string, PastTrip[]>; // norm(place) -> trips
  seenPlaces: Set<string>; // places shown before (feedback "seen")
  tagAdjust: Map<Interest, number>; // from more/less-like-this inside 90 days
  dismissedIds: Set<string>;
  bookedIds: Set<string>;
  dismissedPlaceKind: { key: string; id: string }[]; // within 30 days
  states: Map<string, "seen" | "saved">;
}

function buildMemory(observations: Observation[], ctx: RankContext): Memory {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const destTags = (place: string): Interest[] => ctx.destinations?.find((d) => norm(d.place) === norm(place))?.tags ?? [];
  const m: Memory = {
    visited: new Map(), seenPlaces: new Set(), tagAdjust: new Map(), dismissedIds: new Set(), bookedIds: new Set(),
    dismissedPlaceKind: [], states: new Map(),
  };
  for (const t of ctx.history) {
    for (const p of t.places) {
      const k = norm(p);
      const arr = m.visited.get(k);
      if (arr) arr.push(t); else m.visited.set(k, [t]);
    }
  }
  const now = ctx.now.getTime();
  for (const f of ctx.feedback) {
    const o = byId.get(f.observation_id);
    const at = Date.parse(f.at);
    switch (f.action) {
      case "dismissed":
        m.dismissedIds.add(f.observation_id);
        if (o && !Number.isNaN(at) && now - at <= TUNING.dismissPlaceKindDays * DAY) {
          m.dismissedPlaceKind.push({ key: `${norm(o.place)}|${o.kind}`, id: o.id });
        }
        break;
      case "booked": m.bookedIds.add(f.observation_id); break;
      case "seen":
        if (o) m.seenPlaces.add(norm(o.place));
        if (m.states.get(f.observation_id) !== "saved") m.states.set(f.observation_id, "seen");
        break;
      case "saved": m.states.set(f.observation_id, "saved"); break;
      case "more-like-this":
      case "less-like-this": {
        if (!o || Number.isNaN(at) || now - at > TUNING.tagFeedbackDays * DAY || at > now) break;
        const delta = f.action === "more-like-this" ? 1 : -1;
        for (const tag of new Set([...o.tags, ...destTags(o.place)])) m.tagAdjust.set(tag, (m.tagAdjust.get(tag) ?? 0) + delta);
        break;
      }
    }
  }
  return m;
}

function tagsFor(o: Observation, ctx: RankContext): Interest[] {
  const fromDest = ctx.destinations?.find((d) => norm(d.place) === norm(o.place) || (o.kind === "flight" && d.airports.includes(o.destination)));
  return [...new Set([...o.tags, ...(fromDest?.tags ?? [])])];
}

function matchesAirline(entry: string, o: Extract<Observation, { kind: "flight" }>): boolean {
  const e = norm(entry);
  if (!e) return false;
  const names = [o.seller ?? "", ...o.legs.map((l) => l.carrier), ...o.legs.map((l) => (l.flight_no ?? "").slice(0, 2))].map(norm);
  return names.some((n) => n && (n === e || (e.length > 2 && n.includes(e))));
}

function scoreFit(o: Observation, ctx: RankContext): Scored {
  const { profile } = ctx;
  const comps: { w: number; v: number }[] = [];
  const reasons: string[] = [];
  const r = rangeOf(o);

  if (r) {
    if (profile.free_windows.length) {
      const win = profile.free_windows.find((w) => inside(r, w)) ;
      if (win) {
        comps.push({ w: 3, v: 1 });
        reasons.push(`fits your ${formatDayRange(win.from, win.to)} free window`);
      } else if (profile.free_windows.some((w) => overlaps(r, w))) {
        comps.push({ w: 3, v: 0.5 });
      } else {
        comps.push({ w: 3, v: 0.2 });
      }
    }
    const clash = profile.busy.find((b) => overlaps(r, b));
    if (clash) {
      comps.push({ w: 5, v: 0 });
      reasons.push(`clashes with your busy dates ${formatDayRange(clash.from, clash.to)}${clash.what ? ` (${clash.what})` : ""}`);
    }
  }

  if (o.kind === "flight") {
    const idx = profile.home_airports.indexOf(o.origin);
    comps.push({ w: 2, v: idx < 0 ? 0.1 : Math.max(0.25, 1 - 0.25 * idx) });
    if (idx === 0) reasons.push(`leaves from your home airport ${o.origin}`);

    const stopsOk = o.stops <= profile.flight.max_stops;
    comps.push({ w: 2, v: stopsOk ? 1 : 0 });
    const dur = o.duration_minutes;
    if (dur !== undefined) {
      const limit = profile.flight.max_hours_one_way * 60;
      comps.push({ w: 1.5, v: dur <= limit ? 1 : clamp01(1 - (dur - limit) / (limit * 0.5)) });
    }
    if (o.stops === 0) reasons.push(dur !== undefined ? `direct, ${formatDuration(dur)}` : "direct");
    else if (stopsOk) reasons.push(`${o.stops} ${o.stops === 1 ? "stop" : "stops"}${dur !== undefined ? `, ${formatDuration(dur)}` : ""}`);
    else reasons.push(`${o.stops} stops, over your limit of ${profile.flight.max_stops}`);

    const cap = profile.budget.flight_max;
    if (cap && cap.amount_minor > 0 && cap.currency === o.price.currency) {
      const ratio = o.price.amount_minor / cap.amount_minor;
      comps.push({ w: 2, v: ratio <= 1 ? 1 : clamp01(1 - (ratio - 1) / 0.5) });
      if (ratio <= 1) reasons.push(`within your ${formatMoney(cap)} flight budget`);
    }

    if (profile.flight.avoid_airlines.some((a) => matchesAirline(a, o))) {
      comps.push({ w: 2, v: 0 });
      const hit = profile.flight.avoid_airlines.find((a) => matchesAirline(a, o))!;
      reasons.push(`${hit} is on your avoid list`);
    } else {
      const pref = profile.flight.preferred_airlines.find((a) => matchesAirline(a, o));
      if (pref) {
        comps.push({ w: 2, v: 1 });
        reasons.push(`${pref} is one of your preferred airlines`);
      }
    }

    const first = o.legs[0];
    if (profile.flight.earliest_departure && first) {
      const hhmm = first.depart_at.slice(11, 16); // local clock time of the offset instant
      comps.push({ w: 1, v: hhmm >= profile.flight.earliest_departure ? 1 : 0 });
    }
  }

  if (o.kind === "stay") {
    const kinds = profile.stay.kinds;
    if (kinds.length && o.stay_kind) comps.push({ w: 1, v: kinds.includes(o.stay_kind) ? 1 : 0.3 });
    const min = profile.stay.min_rating;
    if (min !== undefined && o.rating !== undefined) {
      comps.push({ w: 2, v: o.rating >= min ? 1 : clamp01(1 - (min - o.rating) / 2) });
      if (o.rating >= min) reasons.push(`rated ${o.rating}, above your ${min} minimum`);
    }
  }

  if (comps.length === 0) return { value: 0.5, reasons };
  const wsum = comps.reduce((a, c) => a + c.w, 0);
  return { value: clamp01(comps.reduce((a, c) => a + c.w * c.v, 0) / wsum), reasons };
}

function scoreTaste(o: Observation, ctx: RankContext, mem: Memory): Scored {
  const reasons: string[] = [];
  const tags = tagsFor(o, ctx);
  let raw = 0;
  let eff: { tag: Interest; v: number }[] = [];
  if (tags.length) {
    eff = tags.map((tag) => ({
      tag,
      v: Math.max(-2, Math.min(2, (ctx.profile.interests[tag] ?? 0) + (mem.tagAdjust.get(tag) ?? 0))),
    }));
    const vs = eff.map((e) => e.v);
    const max = Math.max(...vs);
    const min = Math.min(...vs);
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    raw = 0.5 * max + 0.3 * mean + 0.2 * min;
  }
  let value = (raw + 2) / 4; // neutral interests = 0.5

  for (const e of [...eff].sort((a, b) => b.v - a.v).filter((e) => e.v >= 1).slice(0, 2)) {
    reasons.push(`${e.v >= 2 ? "you love" : "you like"} ${e.tag}`);
  }
  const avoided = eff.filter((e) => e.v <= -1).sort((a, b) => a.v - b.v)[0];
  if (avoided) reasons.push(`involves ${avoided.tag}, which you avoid`);

  if (ctx.profile.wishlist.some((w) => norm(w) === norm(o.place))) {
    value += 0.2;
    reasons.push("on your wishlist");
  }

  // Recent visit lowers taste unless the owner rated that trip highly.
  const trips = mem.visited.get(norm(o.place)) ?? [];
  const today = msToDay(ctx.now.getTime());
  const recent = trips.filter((t) => t.to <= today && daysBetween(t.to, today) <= TUNING.recentVisitDays);
  if (recent.length) {
    const last = recent.reduce((a, b) => (a.to >= b.to ? a : b));
    if ((last.rating ?? 0) >= TUNING.loveRatingFloor) {
      reasons.push(`you rated your last visit ${last.rating}/5`);
    } else {
      value -= TUNING.recentVisitTastePenalty;
      reasons.push(`you were there recently (${monthName(Number(last.to.slice(5, 7)))} ${last.to.slice(0, 4)})`);
    }
  }
  return { value: clamp01(value), reasons };
}

function scoreUrgency(o: Observation, ctx: RankContext, stale: boolean): Scored {
  const reasons: string[] = [];
  const now = ctx.now.getTime();
  let value = 0;
  const r = rangeOf(o);
  const today = msToDay(now);
  if (r && r.from >= today) {
    const days = daysBetween(today, r.from);
    if (days <= TUNING.urgentDepartureDays) {
      value = Math.max(value, 0.4 + 0.6 * (1 - days / TUNING.urgentDepartureDays));
      const verb = o.kind === "flight" ? "departs" : o.kind === "event" ? "happens" : "starts";
      reasons.push(days === 0 ? `${verb} today` : `${verb} in ${days} ${days === 1 ? "day" : "days"}`);
    }
  }
  const exp = o.provenance.expires_at ? Date.parse(o.provenance.expires_at) : NaN;
  if (!stale && !Number.isNaN(exp) && exp >= now && exp - now <= TUNING.urgentExpiryHours * HOUR) {
    const hours = Math.max(1, Math.floor((exp - now) / HOUR));
    value = Math.max(value, 0.5 + 0.5 * (1 - (exp - now) / (TUNING.urgentExpiryHours * HOUR)));
    reasons.push(hours < 48 ? `price expires in ${hours} h` : `price expires in ${Math.floor(hours / 24)} days`);
  }
  return { value: clamp01(value), reasons };
}

function scoreNovelty(o: Observation, mem: Memory): Scored {
  const k = norm(o.place);
  if (mem.visited.has(k)) return { value: 0.1, reasons: [] };
  if (mem.seenPlaces.has(k)) return { value: 0.4, reasons: [] };
  return { value: 1, reasons: ["a place you have not been to"] };
}

// --- the ranker -----------------------------------------------------------------------------------

export function rank(observations: Observation[], ctx: RankContext): FeedItem[] {
  const now = ctx.now;
  const mem = buildMemory(observations, ctx);
  const groups = groupDuplicates(observations, now);
  const pool = groups.filter((g) => !g.stale).map((g) => g.winner); // the "usual price" is read from live, de-duplicated offers

  const items: FeedItem[] = [];
  for (const g of groups) {
    const o = g.winner;
    if (g.members.some((m) => mem.dismissedIds.has(m.id) || mem.bookedIds.has(m.id))) continue;

    const stale = g.stale;
    const deal = scoreDeal(o, stale, pool, ctx);
    const fit = scoreFit(o, ctx);
    const taste = scoreTaste(o, ctx, mem);
    const urgency = scoreUrgency(o, ctx, stale);
    const novelty = scoreNovelty(o, mem);

    const parts: ScoreParts = {
      deal: round3(deal.value), fit: round3(fit.value), taste: round3(taste.value),
      urgency: round3(urgency.value), novelty: round3(novelty.value),
    };
    let score =
      WEIGHTS.deal * parts.deal + WEIGHTS.fit * parts.fit + WEIGHTS.taste * parts.taste +
      WEIGHTS.urgency * parts.urgency + WEIGHTS.novelty * parts.novelty;

    const reasons: string[] = [];
    if (stale) {
      const r = rangeOf(o);
      const over = r !== null && r.to < msToDay(now.getTime());
      const expired = o.provenance.expires_at !== undefined && Date.parse(o.provenance.expires_at) < now.getTime();
      reasons.push(over ? "already over" : expired ? "offer has expired" : "price is stale, check before booking");
    }
    reasons.push(...deal.reasons);

    const others = g.members.filter((m) => m.id !== o.id);
    if (others.length) {
      const sources = [...new Set(others.map((m) => m.provenance.source).filter((s) => s !== o.provenance.source))];
      if (sources.length) reasons.push(`also seen on ${sources.join(", ")}`);
    }
    reasons.push(...fit.reasons, ...taste.reasons, ...urgency.reasons, ...novelty.reasons);

    const key = `${norm(o.place)}|${o.kind}`;
    if (mem.dismissedPlaceKind.some((d) => d.key === key && d.id !== o.id)) {
      score *= TUNING.dismissPlaceKindFactor;
      reasons.push(`lowered: you dismissed another ${o.kind} for ${o.place} recently`);
    }

    items.push({
      observation: o,
      score: round3(clamp01(score)),
      parts,
      reasons: [...new Set(reasons)].slice(0, 7),
      stale,
      state: mem.states.get(o.id) ?? "new",
    });
  }

  return items.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.observation.provenance.seen_at) - Date.parse(a.observation.provenance.seen_at) ||
      a.observation.id.localeCompare(b.observation.id),
  );
}
