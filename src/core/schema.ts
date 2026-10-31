import { z } from "zod";

/**
 * The contract every part of Rumbo shares: the web pages, the collectors, the ranker, the JSON API
 * and the MCP tools read and write these shapes and nothing else. Dates are `YYYY-MM-DD` in the
 * traveller's local day; instants are ISO 8601 with offset. Money is integer minor units plus an
 * ISO 4217 currency, so no float ever rounds a fare.
 */

export const SCHEMA_VERSION = "rumbo.v1";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Instant = z.string().datetime({ offset: true });
const Iata = z.string().regex(/^[A-Z]{3}$/, "IATA code");
// Links are rendered as <a href> in the feed and in plans, and agents write them. A well-formed URL is not enough:
// "javascript:", "data:", "file:" and "gopher:" are valid URLs too. Only http(s) is accepted (Teyla Shield, SH7).
const Url = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http or https URL");

export const MoneySchema = z.object({
  amount_minor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof MoneySchema>;

/** Who said it. Every fact an agent or a collector adds carries one. */
export const ProvenanceSchema = z.object({
  source: z.string().min(1), // "kiwi-mcp", "travelpayouts", "claude:booking-connector", "owner"
  url: Url.optional(),
  seen_at: Instant,
  expires_at: Instant.optional(), // after this a price is stale and never ranks as a deal
  agent: z.string().optional(), // "claude-scheduled", "codex-automation", "chatgpt-task", "grok-task"
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// --- Profile --------------------------------------------------------------------------------------

export const INTERESTS = [
  "beach", "city", "mountains", "ski", "kitesurf", "surf", "dive", "hiking", "bikepacking", "cycling",
  "running", "triathlon", "padel", "volleyball", "food", "wine", "coffee", "nightlife", "culture",
  "museums", "nature", "road-trip", "festivals", "concerts", "sport-events", "wellness", "family",
] as const;
export const InterestSchema = z.enum(INTERESTS);
export type Interest = z.infer<typeof InterestSchema>;

export const ProfileSchema = z.object({
  name: z.string().optional(),
  home_city: z.string(), // "Valencia"
  home_airports: z.array(Iata).min(1), // ordered by preference: ["VLC", "ALC", "MAD", "BCN"]
  currency: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
  languages: z.array(z.string()).default([]),
  travellers: z.object({ adults: z.number().int().min(1).default(1), children: z.number().int().min(0).default(0) }).prefault({}),
  /** -2 (avoid) to +2 (love). Missing means neutral. */
  interests: z.partialRecord(InterestSchema, z.number().int().min(-2).max(2)).default({}),
  budget: z.object({
    flight_max: MoneySchema.optional(), // per person, return
    night_max: MoneySchema.optional(), // per room
  }).prefault({}),
  flight: z.object({
    max_stops: z.number().int().min(0).max(3).default(1),
    max_hours_one_way: z.number().positive().default(8),
    earliest_departure: z.string().regex(/^\d{2}:\d{2}$/).optional(), // "07:00"
    avoid_airlines: z.array(z.string()).default([]),
    preferred_airlines: z.array(z.string()).default([]),
  }).prefault({}),
  stay: z.object({
    kinds: z.array(z.enum(["hotel", "apartment", "hostel", "villa", "camping", "boutique"])).default([]),
    min_rating: z.number().min(0).max(10).optional(), // Booking-style 0..10
  }).prefault({}),
  /** Windows the owner can travel; ranker boosts offers inside them. */
  free_windows: z.array(z.object({ from: Day, to: Day, note: z.string().optional() })).default([]),
  /** Days already taken (Loco trips, calendar). Offers overlapping them rank lower. */
  busy: z.array(z.object({ from: Day, to: Day, what: z.string().optional() })).default([]),
  /** Places to go some day; small boost and a standing watch. */
  wishlist: z.array(z.string()).default([]),
  /** Facts agents learned, kept with their provenance ("prefers aisle", "Ironman 70.2 in April"). */
  notes: z.array(z.object({ text: z.string(), provenance: ProvenanceSchema })).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

// --- History --------------------------------------------------------------------------------------

export const PastTripSchema = z.object({
  id: z.string(),
  title: z.string(),
  from: Day,
  to: Day,
  places: z.array(z.string()), // city names
  rating: z.number().min(1).max(5).optional(), // the owner's, e.g. from Loco moments
  tags: z.array(InterestSchema).default([]),
  source: z.string().default("loco"),
});
export type PastTrip = z.infer<typeof PastTripSchema>;

// --- Observations: what a collector or an agent saw --------------------------------------------------

export const FlightLegSchema = z.object({
  from: Iata, to: Iata,
  depart_at: Instant, arrive_at: Instant,
  carrier: z.string(), // "Vueling" or "VY"
  flight_no: z.string().optional(),
});

const ObservationBase = z.object({
  id: z.string(), // stable hash of kind + key fields, so re-seeing the same offer updates it
  watch_id: z.string().optional(),
  provenance: ProvenanceSchema,
  title: z.string(),
  place: z.string(), // destination city name, the join key with destinations and the profile
  country: z.string().optional(),
  tags: z.array(InterestSchema).default([]),
  book_url: Url.optional(), // where the owner books; a deep link if no direct one
});

export const ObservationSchema = z.discriminatedUnion("kind", [
  ObservationBase.extend({
    kind: z.literal("flight"),
    origin: Iata, destination: Iata,
    depart_date: Day, return_date: Day.optional(),
    price: MoneySchema, // per person, total for the itinerary
    stops: z.number().int().min(0),
    duration_minutes: z.number().int().positive().optional(), // outbound
    legs: z.array(FlightLegSchema).default([]),
    seller: z.string().optional(), // "Ryanair (direct)", "Kiwi.com"
  }),
  ObservationBase.extend({
    kind: z.literal("stay"),
    check_in: Day, check_out: Day,
    price_total: MoneySchema,
    stay_kind: z.enum(["hotel", "apartment", "hostel", "villa", "camping", "boutique"]).optional(),
    rating: z.number().min(0).max(10).optional(),
    name: z.string(),
  }),
  ObservationBase.extend({
    kind: z.literal("car"),
    pickup_date: Day, dropoff_date: Day,
    price_total: MoneySchema.optional(),
    pickup: z.string(), // airport code or city
  }),
  ObservationBase.extend({
    kind: z.literal("activity"),
    date: Day.optional(),
    price: MoneySchema.optional(),
    duration_minutes: z.number().int().positive().optional(),
    rating: z.number().min(0).max(5).optional(),
  }),
  ObservationBase.extend({
    kind: z.literal("event"),
    date: Day,
    end_date: Day.optional(),
    venue: z.string().optional(),
    price_from: MoneySchema.optional(),
  }),
  ObservationBase.extend({
    kind: z.literal("idea"), // an agent's suggestion with no price yet: "Fuerteventura kite week in March"
    when: z.object({ from: Day, to: Day }).optional(),
    summary: z.string(),
  }),
]);
export type Observation = z.infer<typeof ObservationSchema>;
export type ObservationKind = Observation["kind"];

// --- Watches: what to keep checking -------------------------------------------------------------------

export const WatchSchema = z.object({
  id: z.string(),
  kind: z.enum(["route", "anywhere", "place-events", "place-stays", "place-activities"]),
  label: z.string(),
  origin: z.array(Iata).default([]), // empty = profile.home_airports
  destination: z.array(Iata).default([]), // route only
  place: z.string().optional(), // city for place-* watches
  window: z.object({ from: Day, to: Day }), // departure dates to search
  nights: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).optional(),
  max_price: MoneySchema.optional(), // alert under this
  every_hours: z.number().int().min(1).default(24),
  active: z.boolean().default(true),
  created_by: z.string().default("owner"), // or the agent that proposed it
  last_run_at: Instant.optional(),
});
export type Watch = z.infer<typeof WatchSchema>;

// --- Feed --------------------------------------------------------------------------------------------

export const ScorePartsSchema = z.object({
  deal: z.number().min(0).max(1), // price against this route's / place's baseline
  fit: z.number().min(0).max(1), // free window, airports, stops, hours, budget
  taste: z.number().min(0).max(1), // interests, history, wishlist
  urgency: z.number().min(0).max(1), // expires or happens soon
  novelty: z.number().min(0).max(1), // not seen, not visited
});
export type ScoreParts = z.infer<typeof ScorePartsSchema>;

export const FeedItemSchema = z.object({
  observation: ObservationSchema,
  score: z.number().min(0).max(1),
  parts: ScorePartsSchema,
  reasons: z.array(z.string()), // short, from the parts: "€38 below the usual VLC–LIS fare", "fits 6–9 Dec free window"
  why: z.string().optional(), // one AI line built only from `reasons`
  stale: z.boolean(),
  state: z.enum(["new", "seen", "saved", "dismissed", "booked"]).default("new"),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const FeedbackSchema = z.object({
  observation_id: z.string(),
  action: z.enum(["seen", "saved", "dismissed", "booked", "more-like-this", "less-like-this"]),
  note: z.string().optional(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

// --- Plans: a trip from scratch --------------------------------------------------------------------------

export const PlanRequestSchema = z.object({
  text: z.string().optional(), // the owner's own words, kept
  window: z.object({ from: Day, to: Day }), // when the trip may happen
  nights: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  travellers: z.object({ adults: z.number().int().min(1), children: z.number().int().min(0) }).optional(),
  origin: z.array(Iata).optional(), // default profile.home_airports
  destination: z.string().optional(), // set when the owner already knows where
  interests: z.array(InterestSchema).default([]),
  budget_total: MoneySchema.optional(),
  needs: z.array(z.enum(["flights", "stay", "car", "activities", "events"])).default(["flights", "stay", "activities", "events"]),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const DestinationCandidateSchema = z.object({
  place: z.string(),
  country: z.string(),
  airports: z.array(Iata),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  cheapest_flight: MoneySchema.optional(), // only from an observation
  flight_provenance: ProvenanceSchema.optional(),
});
export type DestinationCandidate = z.infer<typeof DestinationCandidateSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  created_at: Instant,
  request: PlanRequestSchema,
  status: z.enum(["choosing", "planning", "ready", "sent-to-loco", "archived"]),
  candidates: z.array(DestinationCandidateSchema),
  chosen: z.string().optional(), // place
  dates: z.object({ from: Day, to: Day }).optional(),
  /** Observation ids, grouped by section, in the order shown. */
  sections: z.object({
    flights: z.array(z.string()).default([]),
    stay: z.array(z.string()).default([]),
    car: z.array(z.string()).default([]),
    activities: z.array(z.string()).default([]),
    events: z.array(z.string()).default([]),
  }),
  /** Pre-filled searches on the aggregators and providers, for what no API covers. */
  links: z.array(z.object({ section: z.string(), label: z.string(), url: Url })).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;
