import type { AnyTool } from "../tool";
import { tool as agentBrief } from "./agent-brief";
import { tool as feed } from "./feed";
import { tool as feedback } from "./feedback";
import { tool as importHistory } from "./import-history";
import { tool as observe } from "./observe";
import { tool as profileGet } from "./profile-get";
import { tool as profileUpdate } from "./profile-update";
import { tool as toLoco } from "./to-loco";
import { tool as watchAdd } from "./watch-add";
import { tool as watchList } from "./watch-list";

/**
 * The registry. A tool is one file in this folder exporting `tool`; add it here with one line.
 * The plan-feed lane adds rumbo_plan_start and rumbo_plan_get the same way.
 */
export const TOOLS: AnyTool[] = [feed, feedback, profileGet, profileUpdate, watchList, watchAdd, observe, importHistory, agentBrief, toLoco];

export function toolByName(name: string): AnyTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
