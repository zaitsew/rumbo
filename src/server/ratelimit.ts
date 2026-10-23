/**
 * A fixed-window limiter. State lives in the process (pinned to globalThis so each route bundle
 * shares one copy): a brake against a runaway agent or a guessing loop, not a quota system.
 */

export interface Limiter {
  /** True and counted when the call may go ahead; false (nothing counted) when it may not. */
  take(key: string): boolean;
  reset(): void;
}

export interface LimiterOptions {
  perKey: number;
  global: number;
  windowMs: number;
  /** Most distinct keys tracked in one window; beyond it new keys are refused. */
  maxKeys?: number;
  now?: () => number;
}

export function createLimiter(opts: LimiterOptions): Limiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  let window = Math.floor(now() / opts.windowMs);
  let total = 0;
  const counts = new Map<string, number>();
  const roll = () => {
    const current = Math.floor(now() / opts.windowMs);
    if (current !== window) {
      window = current;
      total = 0;
      counts.clear();
    }
  };
  return {
    take(key) {
      roll();
      const used = counts.get(key);
      if (used === undefined && counts.size >= maxKeys) return false;
      if ((used ?? 0) >= opts.perKey || total >= opts.global) return false;
      counts.set(key, (used ?? 0) + 1);
      total += 1;
      return true;
    },
    reset() {
      window = Math.floor(now() / opts.windowMs);
      total = 0;
      counts.clear();
    },
  };
}

/**
 * A lockout counts failures, not calls. `locked(key)` is asked BEFORE any credential is checked, so
 * a locked client gets refused whatever it sends, including the right key. `global` caps failures
 * from everyone in the window; past it nobody gets in until the window rolls (a distributed guesser
 * can lock the owner out for ten minutes, which is the price of never letting a guess through).
 */
export interface Lockout {
  locked(key: string): boolean;
  fail(key: string): void;
  reset(): void;
}

export function createLockout(opts: { perKey: number; global: number; windowMs: number; maxKeys?: number; now?: () => number }): Lockout {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  let window = Math.floor(now() / opts.windowMs);
  let total = 0;
  const fails = new Map<string, number>();
  const roll = () => {
    const current = Math.floor(now() / opts.windowMs);
    if (current !== window) {
      window = current;
      total = 0;
      fails.clear();
    }
  };
  return {
    locked(key) {
      roll();
      return total >= opts.global || (fails.get(key) ?? 0) >= opts.perKey || (!fails.has(key) && fails.size >= maxKeys);
    },
    fail(key) {
      roll();
      total += 1;
      if (fails.has(key) || fails.size < maxKeys) fails.set(key, (fails.get(key) ?? 0) + 1);
    },
    reset() {
      window = Math.floor(now() / opts.windowMs);
      total = 0;
      fails.clear();
    },
  };
}

type Registry = { api?: Limiter; lockout?: Lockout };
const g = globalThis as unknown as { __rumboLimiters?: Registry };
const registry: Registry = (g.__rumboLimiters ??= {});

/** Authenticated API calls: 600 a minute per key, 3000 in all. */
export function apiLimiter(): Limiter {
  return (registry.api ??= createLimiter({ perKey: 600, global: 3000, windowMs: 60_000 }));
}

/** Wrong keys: 10 per client per 10 minutes, 300 in all. */
export function authLockout(): Lockout {
  return (registry.lockout ??= createLockout({ perKey: 10, global: 300, windowMs: 10 * 60_000 }));
}

/**
 * The client address used to count failures.
 *
 * Production sits behind Caddy on a private Docker network, and the only thing that can reach the
 * container is Caddy. Caddy's `reverse_proxy` sets `X-Forwarded-For` to the address it saw; we take
 * the LAST entry (the one the proxy added, never one the client wrote) and only when
 * `RUMBO_TRUST_PROXY=1`, which the compose file sets. Without it no forwarded header is believed and
 * every request shares the bucket "direct": a local `next dev` has no proxy to trust.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  if (env.RUMBO_TRUST_PROXY !== "1") return "direct";
  const hops = headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  return hops[hops.length - 1] ?? "direct";
}
