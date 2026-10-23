import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  FeedbackSchema,
  ObservationSchema,
  PastTripSchema,
  PlanSchema,
  ProfileSchema,
  WatchSchema,
  type Feedback,
  type Observation,
  type ObservationKind,
  type PastTrip,
  type Plan,
  type Profile,
  type Watch,
} from "../core/schema";

/**
 * SQLite through Node's built-in `node:sqlite` (D1). Every table carries `user_id` from the first
 * migration; today the only user is "owner". Rows keep the validated JSON of the shared schema plus
 * the few columns a query needs. Reads and writes go through the zod schemas in src/core/schema.ts.
 */

export const OWNER = "owner";
export type Db = DatabaseSync;

// --- Migrations ---------------------------------------------------------------------------------

/** Ordered and append-only. `PRAGMA user_version` says how many have run. */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: "001_init",
    sql: `
      CREATE TABLE profile (
        user_id    TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE history (
        user_id TEXT NOT NULL,
        id      TEXT NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE watches (
        user_id TEXT NOT NULL,
        id      TEXT NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE observations (
        user_id       TEXT NOT NULL,
        id            TEXT NOT NULL,
        kind          TEXT NOT NULL,
        place         TEXT NOT NULL,
        seen_at       TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        expires_at    TEXT,
        json          TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX observations_seen ON observations (user_id, seen_at);
      CREATE INDEX observations_kind ON observations (user_id, kind, seen_at);
      CREATE TABLE feedback (
        user_id        TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        action         TEXT NOT NULL,
        note           TEXT,
        at             TEXT NOT NULL
      );
      CREATE INDEX feedback_obs ON feedback (user_id, observation_id);
      CREATE TABLE plans (
        user_id    TEXT NOT NULL,
        id         TEXT NOT NULL,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE runs (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        calls       INTEGER NOT NULL DEFAULT 0,
        ok          INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      );
      CREATE TABLE source_calls (
        source TEXT NOT NULL,
        day    TEXT NOT NULL,
        calls  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, day)
      );
    `,
  },
];

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUMBO_DB?.trim() || "./data/rumbo.db";
}

/** Open (and create) a database, switch on WAL and apply any migration not yet applied. */
export function openDb(path: string = dbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const applied = Number(row?.user_version ?? 0);
  if (applied > MIGRATIONS.length) {
    throw new Error(`database is at schema ${applied}, this build knows ${MIGRATIONS.length}: deploy a newer build`);
  }
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Next dev reloads modules; keep one connection per path on globalThis.
const holder = globalThis as unknown as { __rumboDb?: { path: string; db: Db } };

/** The process-wide database at `RUMBO_DB`. */
export function db(): Db {
  const path = dbPath();
  if (holder.__rumboDb && holder.__rumboDb.path !== path) closeDb();
  if (!holder.__rumboDb) holder.__rumboDb = { path, db: openDb(path) };
  return holder.__rumboDb.db;
}

export function closeDb(): void {
  if (holder.__rumboDb) {
    try {
      holder.__rumboDb.db.close();
    } catch {
      // already closed
    }
    holder.__rumboDb = undefined;
  }
}

// --- Helpers ------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Instants are stored as UTC ISO strings so text comparison orders them. */
function utc(instant: string | Date): string {
  return (instant instanceof Date ? instant : new Date(instant)).toISOString();
}

function rows(db: Db, sql: string, ...params: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function one(db: Db, sql: string, ...params: SQLInputValue[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Parse every row; a row that no longer matches the schema is logged and left out, not fatal. */
function parseAll<T>(list: Row[], parse: (json: unknown) => T, what: string): T[] {
  const out: T[] = [];
  for (const r of list) {
    try {
      out.push(parse(JSON.parse(String(r.json))));
    } catch (err) {
      console.warn(`[store] skipping an invalid ${what} row:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

export interface StoredObservation {
  observation: Observation;
  first_seen_at: string;
  seen_at: string;
  expires_at: string | null;
}

export interface StoredFeedback extends Feedback {
  at: string;
}

export interface ListObservationsOptions {
  kinds?: ObservationKind[];
  /** Only observations seen at or after this instant. */
  since?: string;
  /** Stale means `expires_at` has passed. Off by default: a stale price is never a deal. */
  includeStale?: boolean;
  limit?: number;
  now?: Date;
}

export interface RunRecord {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  calls: number;
  ok: boolean;
  error: string | null;
}

/** What the sources lane counts against a daily cap. `day` is `YYYY-MM-DD` (UTC). */
export interface CallLedger {
  count(source: string, day: string): number;
  add(source: string, day: string, n: number): void;
}

// --- The store ------------------------------------------------------------------------------------

export function createStore(db: Db, userId: string = OWNER) {
  function listStoredObservations(opts: ListObservationsOptions = {}): StoredObservation[] {
    const where = ["user_id = ?"];
    const params: SQLInputValue[] = [userId];
    if (opts.kinds && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    if (opts.since) {
      where.push("seen_at >= ?");
      params.push(utc(opts.since));
    }
    if (!opts.includeStale) {
      where.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(utc(opts.now ?? new Date()));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const list = rows(
      db,
      `SELECT json, first_seen_at, seen_at, expires_at FROM observations
       WHERE ${where.join(" AND ")} ORDER BY seen_at DESC, id LIMIT ${limit}`,
      ...params,
    );
    const out: StoredObservation[] = [];
    for (const r of list) {
      try {
        out.push({
          observation: ObservationSchema.parse(JSON.parse(String(r.json))),
          first_seen_at: String(r.first_seen_at),
          seen_at: String(r.seen_at),
          expires_at: r.expires_at == null ? null : String(r.expires_at),
        });
      } catch (err) {
        console.warn("[store] skipping an invalid observation row:", err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  return {
    db,
    userId,

    // profile
    getProfile(): Profile | null {
      const r = one(db, "SELECT json FROM profile WHERE user_id = ?", userId);
      return r ? ProfileSchema.parse(JSON.parse(String(r.json))) : null;
    },
    putProfile(input: unknown, now: Date = new Date()): Profile {
      const profile = ProfileSchema.parse(input);
      db.prepare(
        `INSERT INTO profile (user_id, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(userId, JSON.stringify(profile), utc(now));
      return profile;
    },

    // watches
    listWatches(): Watch[] {
      return parseAll(rows(db, "SELECT json FROM watches WHERE user_id = ? ORDER BY rowid", userId), (j) => WatchSchema.parse(j), "watch");
    },
    getWatch(id: string): Watch | null {
      const r = one(db, "SELECT json FROM watches WHERE user_id = ? AND id = ?", userId, id);
      return r ? WatchSchema.parse(JSON.parse(String(r.json))) : null;
    },
    upsertWatch(input: unknown): Watch {
      const watch = WatchSchema.parse(input);
      db.prepare(
        `INSERT INTO watches (user_id, id, json) VALUES (?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json`,
      ).run(userId, watch.id, JSON.stringify(watch));
      return watch;
    },
    /**
     * Stamp the run time on a watch and touch nothing else. A collection reads its watches, spends
     * seconds in the sources, and must not write the stale copy back over an edit, a pause or a delete
     * made meanwhile; a deleted watch stays deleted. Returns whether a row changed.
     */
    markWatchRun(id: string, at: string): boolean {
      const res = db
        .prepare("UPDATE watches SET json = json_set(json, '$.last_run_at', ?) WHERE user_id = ? AND id = ?")
        .run(at, userId, id);
      return Number(res.changes) > 0;
    },
    deleteWatch(id: string): boolean {
      const res = db.prepare("DELETE FROM watches WHERE user_id = ? AND id = ?").run(userId, id);
      return Number(res.changes) > 0;
    },

    // observations
    /**
     * Upsert by id. An observation older than the stored one (its `seen_at` is earlier) is skipped, so
     * a slow collector or a replayed batch cannot overwrite a fresher price. `first_seen_at` never moves.
     */
    upsertObservations(input: unknown[]): { inserted: number; updated: number; skipped_older: number } {
      const list = input.map((o) => ObservationSchema.parse(o));
      let inserted = 0;
      let updated = 0;
      let skipped_older = 0;
      inTransaction(db, () => {
        const existing = db.prepare("SELECT seen_at FROM observations WHERE user_id = ? AND id = ?");
        const upsert = db.prepare(
          `INSERT INTO observations (user_id, id, kind, place, seen_at, first_seen_at, expires_at, json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET
             kind = excluded.kind, place = excluded.place, seen_at = excluded.seen_at,
             expires_at = excluded.expires_at, json = excluded.json
           WHERE excluded.seen_at >= observations.seen_at`,
        );
        for (const o of list) {
          const seen = utc(o.provenance.seen_at);
          const prior = existing.get(userId, o.id) as { seen_at: string } | undefined;
          if (prior && seen < prior.seen_at) {
            skipped_older++;
            continue;
          }
          if (prior) updated++;
          else inserted++;
          const expires = o.provenance.expires_at ? utc(o.provenance.expires_at) : null;
          upsert.run(userId, o.id, o.kind, o.place, seen, seen, expires, JSON.stringify(o));
        }
      });
      return { inserted, updated, skipped_older };
    },
    listStoredObservations,
    listObservations(opts: ListObservationsOptions = {}): Observation[] {
      return listStoredObservations(opts).map((s) => s.observation);
    },
    getObservation(id: string): Observation | null {
      const r = one(db, "SELECT json FROM observations WHERE user_id = ? AND id = ?", userId, id);
      return r ? ObservationSchema.parse(JSON.parse(String(r.json))) : null;
    },

    // feedback
    addFeedback(input: unknown, now: Date = new Date()): StoredFeedback {
      const fb = FeedbackSchema.parse(input);
      const at = utc(now);
      db.prepare("INSERT INTO feedback (user_id, observation_id, action, note, at) VALUES (?, ?, ?, ?, ?)").run(
        userId,
        fb.observation_id,
        fb.action,
        fb.note ?? null,
        at,
      );
      return { ...fb, at };
    },
    listFeedback(opts: { observationId?: string; since?: string } = {}): StoredFeedback[] {
      const where = ["user_id = ?"];
      const params: SQLInputValue[] = [userId];
      if (opts.observationId) {
        where.push("observation_id = ?");
        params.push(opts.observationId);
      }
      if (opts.since) {
        where.push("at >= ?");
        params.push(utc(opts.since));
      }
      return rows(db, `SELECT observation_id, action, note, at FROM feedback WHERE ${where.join(" AND ")} ORDER BY rowid`, ...params).map(
        (r) => ({
          ...FeedbackSchema.parse({ observation_id: r.observation_id, action: r.action, note: r.note ?? undefined }),
          at: String(r.at),
        }),
      );
    },

    // history
    listHistory(): PastTrip[] {
      const trips = parseAll(rows(db, "SELECT json FROM history WHERE user_id = ?", userId), (j) => PastTripSchema.parse(j), "history");
      return trips.sort((a, b) => b.from.localeCompare(a.from) || a.id.localeCompare(b.id));
    },
    upsertHistory(input: unknown[]): { count: number } {
      const trips = input.map((t) => PastTripSchema.parse(t));
      inTransaction(db, () => {
        const stmt = db.prepare(
          `INSERT INTO history (user_id, id, json) VALUES (?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json`,
        );
        for (const t of trips) stmt.run(userId, t.id, JSON.stringify(t));
      });
      return { count: trips.length };
    },

    // plans
    getPlan(id: string): Plan | null {
      const r = one(db, "SELECT json FROM plans WHERE user_id = ? AND id = ?", userId, id);
      return r ? PlanSchema.parse(JSON.parse(String(r.json))) : null;
    },
    putPlan(input: unknown, now: Date = new Date()): Plan {
      const plan = PlanSchema.parse(input);
      db.prepare(
        `INSERT INTO plans (user_id, id, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(userId, plan.id, JSON.stringify(plan), utc(now));
      return plan;
    },
    /** Save a plan only while the stored copy is not archived. Returns null when it is (or is gone). */
    putPlanUnlessArchived(input: unknown, now: Date = new Date()): Plan | null {
      const plan = PlanSchema.parse(input);
      const res = db
        .prepare("UPDATE plans SET json = ?, updated_at = ? WHERE user_id = ? AND id = ? AND json_extract(json, '$.status') != 'archived'")
        .run(JSON.stringify(plan), utc(now), userId, plan.id);
      return Number(res.changes) > 0 ? plan : null;
    },
    listPlans(): Plan[] {
      return parseAll(rows(db, "SELECT json FROM plans WHERE user_id = ? ORDER BY updated_at DESC, id", userId), (j) => PlanSchema.parse(j), "plan");
    },

    // usage counters for `./check.sh usage`
    usage(now: Date = new Date()): Record<string, string | number> {
      const week = utc(new Date(now.getTime() - 7 * 86_400_000));
      const n = (sql: string, ...p: SQLInputValue[]) => Number(one(db, sql, ...p)?.n ?? 0);
      // Plan notices (id "plan:...") record what a source did for a plan; they are not collector runs.
      const last = one(db, "SELECT MAX(finished_at) AS at FROM runs WHERE ok = 1 AND id NOT LIKE 'plan:%'")?.at;
      return {
        observations: n("SELECT COUNT(*) AS n FROM observations WHERE user_id = ?", userId),
        observations_7d: n("SELECT COUNT(*) AS n FROM observations WHERE user_id = ? AND first_seen_at >= ?", userId, week),
        watches_active: n("SELECT COUNT(*) AS n FROM watches WHERE user_id = ? AND json_extract(json, '$.active') = 1", userId),
        plans: n("SELECT COUNT(*) AS n FROM plans WHERE user_id = ?", userId),
        feedback_7d: n("SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND at >= ?", userId, week),
        last_collect_at: last ? String(last) : "never",
      };
    },
  };
}

export type Store = ReturnType<typeof createStore>;

/** The owner's store on the process-wide database. */
export function store(): Store {
  return createStore(db());
}

// --- Runs and the call ledger (not per user: a source's cap is global) -----------------------------------

export function createCallLedger(db: Db): CallLedger {
  return {
    count(source, day) {
      return Number(one(db, "SELECT calls FROM source_calls WHERE source = ? AND day = ?", source, day)?.calls ?? 0);
    },
    add(source, day, n) {
      if (!Number.isInteger(n) || n < 0) throw new Error("call count must be a non-negative integer");
      db.prepare(
        `INSERT INTO source_calls (source, day, calls) VALUES (?, ?, ?)
         ON CONFLICT(source, day) DO UPDATE SET calls = calls + excluded.calls`,
      ).run(source, day, n);
    },
  };
}

export function recordRun(db: Db, run: RunRecord): void {
  db.prepare(
    `INSERT INTO runs (id, source, started_at, finished_at, calls, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, calls = excluded.calls, ok = excluded.ok, error = excluded.error`,
  ).run(run.id, run.source, utc(run.started_at), run.finished_at ? utc(run.finished_at) : null, run.calls, run.ok ? 1 : 0, run.error);
}

export function listRuns(db: Db, limit = 50): RunRecord[] {
  return rows(db, "SELECT * FROM runs ORDER BY started_at DESC, id LIMIT ?", Math.max(1, Math.min(limit, 500))).map((r) => ({
    id: String(r.id),
    source: String(r.source),
    started_at: String(r.started_at),
    finished_at: r.finished_at == null ? null : String(r.finished_at),
    calls: Number(r.calls),
    ok: Number(r.ok) === 1,
    error: r.error == null ? null : String(r.error),
  }));
}
