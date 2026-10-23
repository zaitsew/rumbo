import type { AnyTool } from "../tool";
import { tool as agentBrief } from "./agent-brief";
import { tool as feed } from "./feed";
import { tool as feedback } from "./feedback";
import { tool as importHistory } from "./import-history";
import { tool as observe } from "./observe";
import { tool as planChoose } from "./plan-choose";
import { tool as planGet } from "./plan-get";
import { tool as planStart } from "./plan-start";
import { tool as profileGet } from "./profile-get";
import { tool as profileUpdate } from "./profile-update";
import { tool as toLoco } from "./to-loco";
import { tool as watchAdd } from "./watch-add";
import { tool as watchList } from "./watch-list";

/**
 * The registry. A tool is one file in this folder exporting `tool`; add it here with one line.
 */
export const TOOLS: AnyTool[] = [feed, feedback, profileGet, profileUpdate, watchList, watchAdd, observe, importHistory, agentBrief, planStart, planGet, planChoose, toLoco];

export function toolByName(name: string): AnyTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
