/** Counters for `./check.sh usage` and `teyla products`: key=value lines from the product's own store. */
import { existsSync } from "node:fs";
import { closeDb, dbPath, store } from "../src/server/store";
import { loadEnv } from "./env";

loadEnv();
const path = dbPath();
if (path !== ":memory:" && !existsSync(path)) {
  // No database yet is a finding, not an error; do not create one just to count it.
  for (const k of ["observations", "observations_7d", "watches_active", "plans", "feedback_7d"]) console.log(`${k}=0`);
  console.log("last_collect_at=never");
  console.log("db=missing");
} else {
  for (const [k, v] of Object.entries(store().usage())) console.log(`${k}=${v}`);
  closeDb();
}
