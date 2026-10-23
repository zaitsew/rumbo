import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DestinationSchema, type Destination } from "../core/destinations";

/**
 * The destination pool, read once from `data/destinations/*.yaml` and cached for the life of the
 * process (the files change with a deploy, not at run time). A file that no longer matches
 * `DestinationSchema` is logged and left out: one bad YAML must not empty the feed.
 */

let cache: { dir: string; list: Destination[] } | null = null;

export function destinationsDir(env: NodeJS.ProcessEnv = process.env): string {
  // scripts/deploy.sh copies data/destinations next to server.js; next.config.ts traces the YAMLs.
  return env.RUMBO_DESTINATIONS_DIR?.trim() || join(/*turbopackIgnore: true*/ process.cwd(), "data", "destinations");
}

export function loadDestinations(dir: string = destinationsDir()): Destination[] {
  if (cache && cache.dir === dir) return cache.list;
  const list: Destination[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort()) {
      try {
        list.push(DestinationSchema.parse(parse(readFileSync(join(dir, f), "utf8"))));
      } catch (err) {
        console.warn(`[destinations] skipping ${f}:`, err instanceof Error ? err.message.split("\n")[0] : err);
      }
    }
  }
  cache = { dir, list };
  return list;
}

export function resetDestinationsCache(): void {
  cache = null;
}
