/**
 * Seed the owner's profile from a YAML file (D6: the real profile never enters the repo).
 *
 *   npm run seed-profile                    reads ./profile.local.yaml (gitignored)
 *   npm run seed-profile -- path/to.yaml    reads another file
 *
 * Copy profile.example.yaml to profile.local.yaml first. After the seed the profile lives in the
 * database; edit it on /profile or let agents update it.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { ProfileSchema } from "../src/core/schema";
import { closeDb, dbPath, store } from "../src/server/store";
import { loadEnv } from "./env";

loadEnv();
const path = process.argv[2] ?? "profile.local.yaml";
if (!existsSync(path)) {
  console.error(`No ${path}. Copy profile.example.yaml to profile.local.yaml, edit it, and run again.`);
  process.exit(1);
}

const parsed = ProfileSchema.safeParse(parse(readFileSync(path, "utf8")));
if (!parsed.success) {
  console.error(`${path} is not a valid profile:`);
  for (const i of parsed.error.issues) console.error(`  ${i.path.join(".") || "(root)"}: ${i.message}`);
  process.exit(1);
}

const s = store();
const existed = s.getProfile() !== null;
s.putProfile(parsed.data);
closeDb();
console.log(`${existed ? "Replaced" : "Saved"} the owner profile in ${dbPath()} (${parsed.data.home_city}, ${parsed.data.home_airports.join("/")}).`);
