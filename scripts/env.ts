import { existsSync } from "node:fs";

/** Scripts run outside Next, so they load `.env` themselves (Node's built-in loader). Real env wins. */
export function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}
