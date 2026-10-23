import { z } from "zod";
import {
  InterestSchema,
  type DestinationCandidate,
  type Interest,
  type Money,
  type PastTrip,
  type PlanRequest,
  type Profile,
  type Provenance,
} from "./schema";
import { dayMs, daysBetween, formatMoney, monthName } from "./money";

/**
 * Destination pool and the "where do I go?" scorer. Pure: the YAML files in data/destinations are
 * read elsewhere (scripts, the server, and the test) and parsed with `DestinationSchema`.
 *
 * Facts in the pool are limited to what can be checked (airports, tags, best months) plus rough
 * flight hours. There are no prices in the pool (D3); a fare comes only from an observation, passed in
 * as `fares`.
 */

const Iata = z.string().regex(/^[A-Z]{3}$/, "IATA code");

/** Origins the pool has travel times for. */
export const HOME_HUBS = ["VLC", "MAD", "BCN"] as const;

export const DestinationSchema = z.object({
  place: z.string().min(1), // city or area name; the join key with observations and the profile
  country: z.string().min(1),
  airports: z.array(Iata).min(1),
  region: z.string().optional(),
  tags: z.array(InterestSchema).min(1),
  best_months: z.array(z.number().int().min(1).max(12)).min(1), // 1 = January
  /**
   * APPROXIMATE typical one-way travel time in hours from Valencia (VLC), Madrid (MAD) or Barcelona
   * (BCN): block time plus the usual connection, or the train ride where that is the norm. A ranking
   * aid for "is it reachable", never a quote. Missing keys mean "not estimated".
   */
  flight_hours_from: z.partialRecord(z.enum(HOME_HUBS), z.number().min(0).max(30)).default({}),
  cost_level: z.number().int().min(1).max(4), // 1 cheap ... 4 expensive, for a traveller from Spain
  notes: z.string().optional(),
});
export type Destination = z.infer<typeof DestinationSchema>;

// --- helpers --------------------------------------------------------------------------------------

export const norm = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Months (1..12) that a date window touches. */
export function windowMonths(from: string, to: string): number[] {
  const out = new Set<number>();
  const start = dayMs(from);
  const end = dayMs(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  // Step by day (windows are at most a few months); stops at 800 days to stay bounded.
  for (let t = start, i = 0; t <= end && i < 800; t += 86_400_000, i++) out.add(new Date(t).getUTCMonth() + 1);
  return [...out].sort((a, b) => a - b);
}

/** "Dec–Mar" from a month list, by runs around the year. Used in reasons. */
function monthRuns(months: number[]): string {
  const set = new Set(months);
  const runs: string[] = [];
  for (let m = 1; m <= 12; m++) {
    if (!set.has(m) || (set.has(m === 1 ? 12 : m - 1) && set.size < 12)) continue;
    let end = m;
    while (set.has(end === 12 ? 1 : end + 1) && (end === 12 ? 1 : end + 1) !== m) end = end === 12 ? 1 : end + 1;
    runs.push(end === m ? monthName(m) : `${monthName(m)}–${monthName(end)}`);
  }
  return runs.length ? runs.join(", ") : "";
}

/** Interest weights the user states by asking: explicit interests in the request count as "love". */
function effectiveInterest(tag: Interest, profile: Profile, req: PlanRequest): number {
  if (req.interests.includes(tag)) return 2;
  return profile.interests[tag] ?? 0;
}

/** -2..+2 for a tag set: leans on the best tag, pulled down by the worst. */
export function tagAffinity(values: number[]): number {
  if (values.length === 0) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.max(-2, Math.min(2, 0.5 * max + 0.3 * mean + 0.2 * min));
}

/**
 * Airports that stand in for a listed hub because they are near it (same metro area or about an hour or
 * two by road). Anything else is unknown, and an unknown origin is never given another airport's hours.
 */
const NEAR_HUB: Record<string, (typeof HOME_HUBS)[number]> = { ALC: "VLC", CDT: "VLC", GRO: "BCN", REU: "BCN" };

/**
 * Hours to the destination from the best home airport, or null when the pool has no estimate for any of
 * them. Listed hubs use their own number; ALC, CDT, GRO and REU borrow their near hub's; an origin outside
 * those yields nothing, so reachability stays unknown (no penalty, no reason).
 */
export function hoursFromHome(d: Destination, homeAirports: string[]): { hours: number; from: string } | null {
  const table = d.flight_hours_from as Record<string, number | undefined>;
  let best: { hours: number; from: string } | null = null;
  for (const a of homeAirports) {
    const hub = (HOME_HUBS as readonly string[]).includes(a) ? a : NEAR_HUB[a];
    const h = hub ? table[hub] : undefined;
    if (hub && h !== undefined && (!best || h < best.hours)) best = { hours: h, from: hub };
  }
  return best;
}

type Fare = { price: Money; provenance: Provenance };

export const DEST_WEIGHTS = { interests: 0.35, season: 0.25, reach: 0.15, history: 0.1, fare: 0.15 } as const;
const WISHLIST_BOOST = 0.08;
/** Beyond max_hours_one_way x this, a place is left out; x LONG_TRIP_ALLOWANCE for trips of 10+ nights. */
const REACH_ALLOWANCE = 1.25;
const LONG_TRIP_ALLOWANCE = 2.5;
const LONG_TRIP_NIGHTS = 10;

// --- the scorer -----------------------------------------------------------------------------------

export function planDestinations(
  req: PlanRequest,
  profile: Profile,
  history: PastTrip[],
  destinations: Destination[],
  fares?: Map<string, Fare>,
): DestinationCandidate[] {
  const months = windowMonths(req.window.from, req.window.to);
  const homes = req.origin?.length ? req.origin : profile.home_airports;
  const maxHours = profile.flight.max_hours_one_way;
  const allowance = maxHours * (req.nights.max >= LONG_TRIP_NIGHTS ? LONG_TRIP_ALLOWANCE : REACH_ALLOWANCE);

  let pool = destinations;
  if (req.destination) {
    const want = norm(req.destination);
    pool = pool.filter((d) => norm(d.place) === want || norm(d.country) === want || d.airports.includes(req.destination!.toUpperCase()));
  }

  // Fares by normalised place; compare only inside one currency.
  const fareByPlace = new Map<string, Fare>();
  for (const [k, v] of fares ?? []) fareByPlace.set(norm(k), v);
  const fareCurrencies = new Map<string, number[]>();
  for (const f of fareByPlace.values()) {
    const arr = fareCurrencies.get(f.price.currency) ?? [];
    arr.push(f.price.amount_minor);
    fareCurrencies.set(f.price.currency, arr);
  }

  const wish = new Set(profile.wishlist.map(norm));
  const out: DestinationCandidate[] = [];

  for (const d of pool) {
    const reasons: string[] = [];
    const reach = hoursFromHome(d, homes);
    if (reach && reach.hours > allowance) continue; // not reachable for this trip

    // --- interests
    const eff = d.tags.map((t) => effectiveInterest(t, profile, req));
    const taste = (tagAffinity(eff) + 2) / 4; // 0..1, neutral 0.5
    let interests = taste;
    if (req.interests.length) {
      const covered = req.interests.filter((i) => d.tags.includes(i));
      interests = 0.6 * (covered.length / req.interests.length) + 0.4 * taste;
      if (covered.length) reasons.push(`has ${covered.join(", ")}, which you asked for`);
    }
    const loved = d.tags
      .filter((t) => !req.interests.includes(t) && (profile.interests[t] ?? 0) >= 1)
      .sort((a, b) => (profile.interests[b] ?? 0) - (profile.interests[a] ?? 0))
      .slice(0, 2);
    for (const t of loved) reasons.push(`${(profile.interests[t] ?? 0) >= 2 ? "you love" : "you like"} ${t}`);
    const disliked = d.tags.filter((t) => !req.interests.includes(t) && (profile.interests[t] ?? 0) <= -1);
    if (disliked.length) reasons.push(`includes ${disliked[0]}, which you avoid`);

    // --- season
    let season = 0.5;
    if (months.length) {
      const best = new Set(d.best_months);
      const near = (m: number) => best.has(m === 1 ? 12 : m - 1) || best.has(m === 12 ? 1 : m + 1);
      const hits: number[] = months.map((m) => (best.has(m) ? 1 : near(m) ? 0.4 : 0));
      season = hits.reduce((a, b) => a + b, 0) / months.length;
      const inSeason = months.filter((m) => best.has(m));
      if (inSeason.length === months.length) reasons.push(`in season in ${monthRuns(months)}`);
      else if (inSeason.length) reasons.push(`in season for part of your window (${monthRuns(inSeason)})`);
      else reasons.push(`best in ${monthRuns(d.best_months)}, outside your window`);
    }

    // --- reach
    let reachScore = 0.5;
    if (reach) {
      reachScore = reach.hours <= maxHours * 0.5 ? 1 : clamp01(1 - 0.7 * ((reach.hours - maxHours * 0.5) / (maxHours * 0.5)));
      reasons.push(`about ${reach.hours} h from ${reach.from} (approximate)`);
    }

    // --- history
    let historyScore = 1;
    const refDay = req.window.from;
    const visits = history.filter((t) => t.places.some((p) => norm(p) === norm(d.place)));
    if (visits.length) {
      const last = visits.reduce((a, b) => (a.to >= b.to ? a : b));
      const ago = daysBetween(last.to, refDay);
      if (ago >= 0 && ago <= 365) {
        if ((last.rating ?? 0) >= 4) {
          historyScore = 0.85;
          reasons.push(`you rated your last visit ${last.rating}/5`);
        } else {
          historyScore = 0.2;
          reasons.push(`you were there recently (${monthName(Number(last.to.slice(5, 7)))} ${last.to.slice(0, 4)})`);
        }
      } else {
        historyScore = 0.6;
      }
    } else {
      reasons.push("a place you have not been to");
    }

    // --- fare
    let fareScore: number | undefined;
    const fare = fareByPlace.get(norm(d.place));
    if (fareByPlace.size > 0) {
      if (fare) {
        const same = fareCurrencies.get(fare.price.currency) ?? [];
        const lo = Math.min(...same);
        const hi = Math.max(...same);
        fareScore = same.length < 2 || hi === lo ? 0.6 : 1 - (fare.price.amount_minor - lo) / (hi - lo);
        reasons.push(fare.price.amount_minor === lo && same.length > 1 ? `cheapest fare found, ${formatMoney(fare.price)}` : `fare found at ${formatMoney(fare.price)}`);
      } else {
        fareScore = 0.4; // no fare seen: not a reason against, but not a plus
      }
    }

    // --- wishlist
    const onWishlist = wish.has(norm(d.place));
    if (onWishlist) reasons.push("on your wishlist");

    // Weighted mean over the components that exist; the wishlist adds a small boost on top.
    const parts: [number, number][] = [
      [DEST_WEIGHTS.interests, interests],
      [DEST_WEIGHTS.season, season],
      [DEST_WEIGHTS.reach, reachScore],
      [DEST_WEIGHTS.history, historyScore],
    ];
    if (fareScore !== undefined) parts.push([DEST_WEIGHTS.fare, fareScore]);
    const wsum = parts.reduce((a, [w]) => a + w, 0);
    let score = parts.reduce((a, [w, v]) => a + w * v, 0) / wsum;
    if (onWishlist) score += WISHLIST_BOOST;

    const cand: DestinationCandidate = {
      place: d.place,
      country: d.country,
      airports: d.airports,
      score: round3(clamp01(score)),
      reasons,
    };
    if (fare) {
      cand.cheapest_flight = fare.price;
      cand.flight_provenance = fare.provenance;
    }
    out.push(cand);
  }

  return out.sort((a, b) => b.score - a.score || a.place.localeCompare(b.place));
}
