/**
 * Validate data/destinations/*.yaml. For now each file only has to parse and carry `place`,
 * `country` and `airports`.
 * TODO: replace with the real schema once src/core/destinations.ts lands (core-rank lane).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DIR = "data/destinations";
if (!existsSync(DIR)) {
  console.log(`validate-data: no ${DIR}/ yet, nothing to check.`);
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
const problems: string[] = [];
for (const f of files) {
  let doc: unknown;
  try {
    doc = parse(readFileSync(join(DIR, f), "utf8"));
  } catch (err) {
    problems.push(`${f}: not valid YAML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    continue;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    problems.push(`${f}: expected a mapping`);
    continue;
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.place !== "string" || !d.place) problems.push(`${f}: missing \`place\``);
  if (typeof d.country !== "string" || !d.country) problems.push(`${f}: missing \`country\``);
  if (!Array.isArray(d.airports) || d.airports.length === 0) problems.push(`${f}: \`airports\` must be a non-empty list`);
}

if (problems.length > 0) {
  console.error("validate-data FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`validate-data: ${files.length} destination file(s) OK`);
