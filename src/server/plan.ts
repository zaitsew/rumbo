import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DestinationSchema, norm, planDestinations, type Destination } from "../core/destinations";
import { linksForPlan } from "../core/links";
import { daysBetween } from "../core/money";
import { parsePlanText, type KnownPlace } from "../core/parse";
import { rank } from "../core/rank";
import {
  PlanRequestSchema,
  PlanSchema,
  type DestinationCandidate,
  type Money,
  type Observation,
  type Plan,
  type PlanRequest,
  type Profile,
  type Provenance,
} from "../core/schema";
import { aiEnabled, aiParsePlan, type AiOptions } from "./ai";
import { sawk } from "./sawk";
import {
  ALL_SOURCES,
  OBSERVATION_KIND_OF,
  childAges,
  runSources,
  type CallLedger,
  type CallRecord,
  type Env,
  type Source,
  type SourceQuery,
} from "./sources";
import { addDays } from "./sources/http";
import { countryOfCity } from "./sources/places";
import { createCallLedger, createStore, db as processDb, recordRun, type Store } from "./store";

/**
 * The planner: one sentence (or a form) to a trip. `startPlan` reads the request, ranks destinations and
 * asks the sources for live fares; `choosePlace` fills Flights, Stay, Car, Activities and Events for the
 * place the owner picked. Prices come only from observations a source returned (D3). A source that
 * fails or is off is recorded and shown, never fatal.
 */

/** Source calls one step may make: five fare searches, or flights + stays + activities + events. */
export const MAX_CALLS_PER_STEP = 12;
export const CANDIDATES = 5;
const FARE_TIMEOUT_MS = 20_000;
const PER_SECTION = { flights: 8, stay: 8, activities: 10, events: 10 } as const;
/** Below this the rules parser is not trusted alone and the AI step runs (when it is on). */
export const AI_BELOW = 0.7;

export class PlanError extends Error {
  constructor(message: string, readonly code: "no_profile" | "not_found" | "bad_request" = "bad_request") {
    super(message);
    this.name = "PlanError";
  }
}

export interface PlanDeps {
  store?: Store;
  sources?: Source[];
  env?: Env;
  now?: Date;
  fetch?: typeof fetch;
  ledger?: CallLedger;
  destinations?: Destination[];
  /** `false` turns the AI step off whatever the env says. */
  ai?: AiOptions | false;
  timeoutMs?: number;
}

interface Ctx {
  store: Store;
  sources: Source[];
  env: Env;
  now: Date;
  today: string;
  fetch?: typeof fetch;
  ledger: CallLedger;
  destinations: Destination[];
  ai: AiOptions | false;
  timeoutMs: number;
}

function context(userId: string, deps: PlanDeps): Ctx {
  const now = deps.now ?? new Date();
  const store = deps.store ?? createStore(processDb(), userId);
  return {
    store,
    sources: deps.sources ?? [...ALL_SOURCES, sawk],
    env: deps.env ?? process.env,
    now,
    today: now.toISOString().slice(0, 10),
    fetch: deps.fetch,
    ledger: deps.ledger ?? createCallLedger(store.db),
    destinations: deps.destinations ?? loadDestinations(),
    ai: deps.ai ?? { env: deps.env },
    timeoutMs: deps.timeoutMs ?? FARE_TIMEOUT_MS,
  };
}

// --- The destination pool (lane D's src/server/destinations.ts replaces this loader) ---------------------

let pool: { dir: string; list: Destination[] } | undefined;

/** `data/destinations/*.yaml`, validated. A file that does not parse is skipped, not fatal. */
export function loadDestinations(dir: string = join(process.cwd(), "data", "destinations")): Destination[] {
  if (pool?.dir === dir) return pool.list;
  const list: Destination[] = [];
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
      const parsed = DestinationSchema.safeParse(parseYaml(readFileSync(join(dir, f), "utf8")));
      if (parsed.success) list.push(parsed.data);
      else console.warn(`[plan] skipping ${f}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
  } catch (err) {
    console.warn("[plan] cannot read the destination pool:", err instanceof Error ? err.message : err);
  }
  pool = { dir, list };
  return list;
}

// --- Reading the request ---------------------------------------------------------------------------------

export interface StartInput {
  /** The owner's own words. */
  text?: string;
  /** Fields from the form; they win over the sentence. */
  request?: Partial<PlanRequest>;
}

const known = (d: Destination[]): KnownPlace[] => d.map((x) => ({ place: x.place, country: x.country }));

/** Fill the gaps the sentence left from the profile and from sensible defaults. */
function complete(partial: Partial<PlanRequest>, profile: Profile, today: string): PlanRequest {
  let window = partial.window ?? { from: addDays(today, 14), to: addDays(today, 14 + 60) };
  if (window.from < today) window = { ...window, from: today };
  if (window.to < window.from) window = { from: window.from, to: window.from };
  let nights = partial.nights ?? { min: 3, max: 5 };
  if (nights.max < nights.min) nights = { min: nights.min, max: nights.min };
  return PlanRequestSchema.parse({
    ...partial,
    window,
    nights,
    travellers: partial.travellers ?? { adults: profile.travellers.adults, children: profile.travellers.children },
    origin: partial.origin?.length ? partial.origin : profile.home_airports,
    interests: partial.interests ?? [],
    needs: partial.needs?.length ? partial.needs : undefined,
  });
}

/** Rules first; the AI fills what the rules did not find, only when the rules are unsure. */
export async function readRequest(input: StartInput, profile: Profile, ctx: Pick<Ctx, "today" | "destinations" | "ai">): Promise<Partial<PlanRequest>> {
  const text = input.text?.trim() ?? "";
  let merged: Partial<PlanRequest> = {};
  if (text) {
    const rules = parsePlanText(text, ctx.today, profile, known(ctx.destinations));
    merged = { ...rules.request };
    if (rules.confidence < AI_BELOW && ctx.ai !== false && aiEnabled(ctx.ai.env)) {
      const ai = await aiParsePlan(text, ctx.today, profile, ctx.ai);
      if (ai) merged = { ...ai, ...merged }; // the rules' own findings stand; the AI fills the gaps
    }
    merged.text = text;
  }
  return { ...merged, ...definedOnly(input.request ?? {}) };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// --- Source calls, with a budget ---------------------------------------------------------------------------

interface Notice {
  source: string;
  ok: boolean;
  calls: number;
  error?: string;
}

/**
 * Run each query on the sources that serve it, in order, until the step's budget is spent. A source whose
 * estimated calls do not fit is skipped and said so. Disabled sources are passed through so their
 * "set this key" message reaches the page.
 */
async function runBudgeted(queries: SourceQuery[], ctx: Ctx, budget = MAX_CALLS_PER_STEP): Promise<{ observations: Observation[]; notices: Notice[] }> {
  let remaining = budget;
  const jobs: { query: SourceQuery; sources: Source[] }[] = [];
  const notices: Notice[] = [];
  for (const query of queries) {
    const serving = ctx.sources.filter((s) => s.kinds.includes(OBSERVATION_KIND_OF[query.kind]));
    const picked: Source[] = [];
    for (const s of serving) {
      if (!s.enabled(ctx.env)) {
        picked.push(s); // costs nothing; runSources records why it is off
        continue;
      }
      const n = Math.max(0, s.callsFor?.(query) ?? 1);
      if (n > remaining) {
        notices.push({ source: s.name, ok: false, calls: 0, error: `skipped: this step is limited to ${budget} source calls` });
        continue;
      }
      remaining -= n;
      picked.push(s);
    }
    if (picked.length) jobs.push({ query, sources: picked });
  }

  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        return await runSources([job.query], { sources: job.sources, ledger: ctx.ledger, env: ctx.env, now: ctx.now, fetch: ctx.fetch, timeoutMs: ctx.timeoutMs });
      } catch (err) {
        // runSources records source failures itself; this is a bug or a bad query, and must not stop the plan.
        const msg = err instanceof Error ? err.message : String(err);
        return { observations: [] as Observation[], calls: job.sources.map((s): CallRecord => ({ source: s.name, n: 0, ok: false, error: msg.slice(0, 200) })) };
      }
    }),
  );

  const byId = new Map<string, Observation>();
  const calls: CallRecord[] = [];
  for (const r of results) {
    calls.push(...r.calls);
    for (const o of r.observations) if (!byId.has(o.id)) byId.set(o.id, o);
  }
  return { observations: [...byId.values()], notices: [...notices, ...summarise(calls)] };
}

/** One notice per source: calls made, and the first error. */
function summarise(calls: CallRecord[]): Notice[] {
  const by = new Map<string, Notice>();
  for (const c of calls) {
    const n = by.get(c.source) ?? { source: c.source, ok: true, calls: 0 };
    n.calls += c.n;
    if (!c.ok) {
      n.ok = false;
      n.error ??= c.error ?? (c.skipped ? `skipped (${c.skipped})` : "failed");
    }
    by.set(c.source, n);
  }
  return [...by.values()];
}

/** Notices live in `runs`, keyed `plan:<id>:<step>:<n>`, so the schema needs no new field. */
function saveNotices(store: Store, planId: string, step: "fares" | "choose", notices: Notice[], now: Date): void {
  const at = now.toISOString();
  notices.forEach((n, i) => {
    recordRun(store.db, {
      id: `plan:${planId}:${step}:${i}`,
      source: n.source,
      started_at: at,
      finished_at: at,
      calls: n.calls,
      ok: n.ok,
      error: n.error ?? null,
    });
  });
}

function clearNotices(store: Store, planId: string, step: string): void {
  store.db.prepare("DELETE FROM runs WHERE substr(id, 1, ?) = ?").run(`plan:${planId}:${step}:`.length, `plan:${planId}:${step}:`);
}

export interface PlanNotice { source: string; ok: boolean; calls: number; error: string | null; step: string }

/** What each source did for this plan: calls made, or why it did not run. */
export function planNotices(userId: string, id: string, deps: PlanDeps = {}): PlanNotice[] {
  const store = deps.store ?? createStore(processDb(), userId);
  const prefix = `plan:${id}:`;
  const rows = store.db.prepare("SELECT id, source, calls, ok, error FROM runs WHERE substr(id, 1, ?) = ? ORDER BY id").all(prefix.length, prefix) as {
    id: string; source: string; calls: number; ok: number; error: string | null;
  }[];
  return rows.map((r) => ({ source: r.source, ok: Number(r.ok) === 1, calls: Number(r.calls), error: r.error, step: r.id.split(":")[2] ?? "" }));
}

// --- Starting a plan -----------------------------------------------------------------------------------------

type Fare = { price: Money; provenance: Provenance };

/** The days a flight may leave on so that the trip still fits inside the window. */
function departWindow(r: PlanRequest): { from: string; to: string } {
  const last = addDays(r.window.to, -r.nights.min);
  return { from: r.window.from, to: last < r.window.from ? r.window.from : last };
}

function flightsQuery(origin: string[], destination: string[], window: { from: string; to: string }, nights: { min: number; max: number }, r: PlanRequest, profile: Profile): SourceQuery {
  const children = r.travellers?.children ?? 0;
  return {
    kind: "flights",
    origin,
    destination,
    window,
    nights,
    adults: r.travellers?.adults ?? profile.travellers.adults,
    children,
    child_ages: childAges({ children }),
    currency: profile.currency,
    max_stops: profile.flight.max_stops,
  };
}

const sameCurrencyFirst = (a: Money, currency: string): number => (a.currency === currency ? 0 : 1);

/** Cheapest fare per candidate, from observations only; a trip must fit inside the request's window. */
export function cheapestFares(candidates: Pick<DestinationCandidate, "place" | "airports">[], observations: Observation[], r: PlanRequest, currency: string): Map<string, Fare> {
  const out = new Map<string, Fare>();
  for (const c of candidates) {
    let best: Observation | undefined;
    for (const o of observations) {
      if (o.kind !== "flight") continue;
      const here = c.airports.includes(o.destination) || norm(o.place) === norm(c.place);
      if (!here) continue;
      if (o.return_date && o.return_date > r.window.to) continue;
      if (o.depart_date < r.window.from) continue;
      if (!best || best.kind !== "flight") { best = o; continue; }
      const a = sameCurrencyFirst(o.price, currency), b = sameCurrencyFirst(best.price, currency);
      if (a < b || (a === b && o.price.currency === best.price.currency && o.price.amount_minor < best.price.amount_minor)) best = o;
    }
    if (best && best.kind === "flight") out.set(c.place, { price: best.price, provenance: best.provenance });
  }
  return out;
}

function syntheticCandidate(name: string, destinations: Destination[]): DestinationCandidate {
  const d = destinations.find((x) => norm(x.place) === norm(name));
  return { place: d?.place ?? name, country: d?.country ?? "", airports: d?.airports ?? [], score: 0.5, reasons: ["you named it"] };
}

function newId(): string {
  return `pl_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/**
 * Read the request, rank destinations, fetch live fares for the best few and store the plan. When the
 * request names one place, go straight to planning it.
 */
export async function startPlan(userId: string, input: StartInput, deps: PlanDeps = {}): Promise<Plan> {
  const ctx = context(userId, deps);
  const profile = ctx.store.getProfile();
  if (!profile) throw new PlanError("Fill in your profile first: Rumbo needs your home airports.", "no_profile");
  if (!input.text?.trim() && !input.request) throw new PlanError("Describe the trip, or fill in the form.");

  const request = complete(await readRequest(input, profile, ctx), profile, ctx.today);
  const history = ctx.store.listHistory();
  const id = newId();
  const created_at = ctx.now.toISOString();
  const base = { id, created_at, request, sections: { flights: [], stay: [], car: [], activities: [], events: [] }, links: [] };

  // The owner already knows where.
  if (request.destination) {
    const matches = planDestinations(request, profile, history, ctx.destinations);
    if (matches.length <= 1) {
      const only = matches[0] ?? syntheticCandidate(request.destination, ctx.destinations);
      const plan = ctx.store.putPlan(PlanSchema.parse({ ...base, status: "choosing", candidates: [only] }), ctx.now);
      return await planPlace(ctx, plan, profile, only, undefined);
    }
  }

  const ranked = planDestinations(request, profile, history, ctx.destinations).slice(0, CANDIDATES);
  let candidates = ranked;
  let notices: Notice[] = [];
  if (ranked.length && request.needs.includes("flights")) {
    const window = departWindow(request);
    const queries = ranked.filter((c) => c.airports.length).map((c) => flightsQuery(request.origin ?? profile.home_airports, c.airports, window, request.nights, request, profile));
    const { observations, notices: n } = await runBudgeted(queries, ctx);
    notices = n;
    if (observations.length) ctx.store.upsertObservations(observations);
    const fares = cheapestFares(ranked, observations, request, profile.currency);
    if (fares.size) {
      // Re-score only these places, now that some have a fare; the rest of the pool has none to compare.
      const subset = ctx.destinations.filter((d) => ranked.some((c) => norm(c.place) === norm(d.place)));
      candidates = planDestinations(request, profile, history, subset, fares);
    }
  }

  const plan = ctx.store.putPlan(PlanSchema.parse({ ...base, status: "choosing", candidates }), ctx.now);
  saveNotices(ctx.store, id, "fares", notices, ctx.now);
  return plan;
}

export function getPlan(userId: string, id: string, deps: PlanDeps = {}): Plan | null {
  return (deps.store ?? createStore(processDb(), userId)).getPlan(id);
}

export function listPlans(userId: string, deps: PlanDeps = {}): Plan[] {
  return (deps.store ?? createStore(processDb(), userId)).listPlans();
}

export function archivePlan(userId: string, id: string, deps: PlanDeps = {}): Plan {
  const store = deps.store ?? createStore(processDb(), userId);
  const plan = store.getPlan(id);
  if (!plan) throw new PlanError("That plan does not exist.", "not_found");
  return store.putPlan({ ...plan, status: "archived" }, deps.now);
}

// --- Choosing a place ---------------------------------------------------------------------------------------------

export interface TripDates { from: string; to: string }

/** The dates the owner gave, else the cheapest fare found for the place, else the window start plus the shortest stay. */
export function pickDates(plan: Plan, candidate: DestinationCandidate, stored: Observation[], given?: TripDates, currency = "EUR"): TripDates {
  if (given) return given;
  const fares = stored.filter((o): o is Extract<Observation, { kind: "flight" }> => o.kind === "flight" && !!o.return_date && (candidate.airports.includes(o.destination) || norm(o.place) === norm(candidate.place)));
  const fitting = fares.filter((o) => {
    const nights = daysBetween(o.depart_date, o.return_date!);
    return o.depart_date >= plan.request.window.from && o.return_date! <= plan.request.window.to && nights >= plan.request.nights.min && nights <= plan.request.nights.max;
  });
  const best = fitting.sort((a, b) => sameCurrencyFirst(a.price, currency) - sameCurrencyFirst(b.price, currency) || a.price.amount_minor - b.price.amount_minor)[0];
  if (best) return { from: best.depart_date, to: best.return_date! };
  const from = plan.request.window.from;
  return { from, to: addDays(from, plan.request.nights.min) };
}

function validDates(d: TripDates, today: string): string | null {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (!ok(d.from) || !ok(d.to)) return "Dates must be YYYY-MM-DD.";
  if (d.to < d.from) return "The trip cannot end before it starts.";
  if (d.from < today) return "The trip cannot start in the past.";
  if (daysBetween(d.from, d.to) > 60) return "Trips are limited to 60 nights.";
  return null;
}

/** Choose a place from the candidates (or any place by name) and fill the plan's sections. */
export async function choosePlace(userId: string, id: string, place: string, dates?: TripDates, deps: PlanDeps = {}): Promise<Plan> {
  const ctx = context(userId, deps);
  const profile = ctx.store.getProfile();
  if (!profile) throw new PlanError("Fill in your profile first: Rumbo needs your home airports.", "no_profile");
  const plan = ctx.store.getPlan(id);
  if (!plan) throw new PlanError("That plan does not exist.", "not_found");
  if (plan.status === "archived") throw new PlanError("That plan is archived.");
  const wanted = place.trim();
  if (!wanted) throw new PlanError("Choose a place.");
  if (dates) {
    const bad = validDates(dates, ctx.today);
    if (bad) throw new PlanError(bad);
  }
  const candidate = plan.candidates.find((c) => norm(c.place) === norm(wanted)) ?? syntheticCandidate(wanted, ctx.destinations);
  return await planPlace(ctx, plan, profile, candidate, dates);
}

const inRange = (day: string, from: string, to: string) => day >= from && day <= to;

async function planPlace(ctx: Ctx, plan: Plan, profile: Profile, candidate: DestinationCandidate, given?: TripDates): Promise<Plan> {
  const r = plan.request;
  const stored = ctx.store.listObservations({ kinds: ["flight"], limit: 1000, now: ctx.now });
  const dates = pickDates(plan, candidate, stored, given, profile.currency);
  const nights = Math.max(1, daysBetween(dates.from, dates.to));
  const origins = r.origin?.length ? r.origin : profile.home_airports;
  const adults = r.travellers?.adults ?? profile.travellers.adults;
  const children = r.travellers?.children ?? 0;
  const iso2 = countryOfCity(candidate.place);
  const extra: Notice[] = [];

  const queries: SourceQuery[] = [];
  if (r.needs.includes("flights")) {
    if (candidate.airports.length) queries.push(flightsQuery(origins, candidate.airports, { from: dates.from, to: dates.from }, { min: nights, max: nights }, r, profile));
    else extra.push({ source: "rumbo", ok: false, calls: 0, error: `no airport known for ${candidate.place}; use the flight links` });
  }
  if (r.needs.includes("stay")) {
    queries.push({ kind: "stays", place: candidate.place, country: iso2, check_in: dates.from, check_out: dates.to, adults, children, child_ages: childAges({ children }), currency: profile.currency });
  }
  if (r.needs.includes("activities")) queries.push({ kind: "activities", place: candidate.place, country: iso2, currency: profile.currency });
  if (r.needs.includes("events")) queries.push({ kind: "events", place: candidate.place, country: iso2, window: dates });

  const { observations: fresh, notices } = await runBudgeted(queries, ctx);
  if (fresh.length) ctx.store.upsertObservations(fresh);

  // Fresh results plus what collectors already stored for this place.
  const pool = new Map<string, Observation>();
  for (const o of fresh) pool.set(o.id, o);
  for (const o of ctx.store.listObservations({ kinds: ["event", "activity"], limit: 2000, now: ctx.now })) {
    if (norm(o.place) === norm(candidate.place) && !pool.has(o.id)) pool.set(o.id, o);
  }
  for (const o of ctx.store.listObservations({ kinds: ["flight", "stay"], limit: 2000, now: ctx.now })) {
    if (!pool.has(o.id) && norm(o.place) === norm(candidate.place)) pool.set(o.id, o);
  }

  const belongs = (o: Observation): boolean => {
    switch (o.kind) {
      case "flight": return o.depart_date === dates.from && (!o.return_date || o.return_date === dates.to);
      case "stay": return o.check_in === dates.from && o.check_out === dates.to;
      case "event": return inRange(o.date, dates.from, dates.to) || (!!o.end_date && o.date <= dates.to && o.end_date >= dates.from);
      case "activity": return !o.date || inRange(o.date, dates.from, dates.to);
      default: return false;
    }
  };

  const items = rank([...pool.values()].filter(belongs), {
    profile,
    history: ctx.store.listHistory(),
    feedback: ctx.store.listFeedback().map((f) => ({ observation_id: f.observation_id, action: f.action, at: f.at })),
    now: ctx.now,
    destinations: ctx.destinations,
    watches: ctx.store.listWatches(),
  }).filter((i) => !i.stale);

  const section = (kind: Observation["kind"], max: number): string[] => items.filter((i) => i.observation.kind === kind).slice(0, max).map((i) => i.observation.id);
  const sections = {
    flights: section("flight", PER_SECTION.flights),
    stay: section("stay", PER_SECTION.stay),
    car: [] as string[], // links only: no rental source yet
    activities: section("activity", PER_SECTION.activities),
    events: section("event", PER_SECTION.events),
  };

  const links = linksForPlan({
    place: candidate.place,
    country: candidate.country || undefined,
    airports: candidate.airports,
    origins,
    dates,
    adults,
    children,
    needs: [...new Set([...r.needs, "car"])],
  });

  const next = ctx.store.putPlan(
    PlanSchema.parse({ ...plan, status: "ready", chosen: candidate.place, dates, sections, links, candidates: plan.candidates.some((c) => c.place === candidate.place) ? plan.candidates : [...plan.candidates, candidate] }),
    ctx.now,
  );
  clearNotices(ctx.store, plan.id, "choose");
  saveNotices(ctx.store, plan.id, "choose", [...extra, ...notices], ctx.now);
  return next;
}
