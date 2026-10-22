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

type Registry = { api?: Limiter; authFail?: Limiter };
const g = globalThis as unknown as { __rumboLimiters?: Registry };
const registry: Registry = (g.__rumboLimiters ??= {});

/** Authenticated API calls: 600 a minute per key, 3000 in all. */
export function apiLimiter(): Limiter {
  return (registry.api ??= createLimiter({ perKey: 600, global: 3000, windowMs: 60_000 }));
}

/** Wrong keys: 10 per address per 10 minutes, so the key cannot be guessed over the wire. */
export function authFailLimiter(): Limiter {
  return (registry.authFail ??= createLimiter({ perKey: 10, global: 300, windowMs: 10 * 60_000 }));
}

/** The caller's address: first hop of `x-forwarded-for`, else `x-real-ip`, else "unknown". */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || "unknown";
}
