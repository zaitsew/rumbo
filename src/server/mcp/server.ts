import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../../../package.json";
import type { Store } from "../store";
import { ToolError, type AnyTool, type ToolContext } from "./tool";
import { TOOLS } from "./tools";

/**
 * The MCP server: a registry of tools served over stateless Streamable HTTP. Built with the SDK's
 * low-level `Server` so validation errors come back in Rumbo's `{ error, detail }` shape instead of
 * a framework message. A new server per request: no session, nothing to clean up.
 */

/**
 * Instructions, tool descriptions, parameter descriptions and tool outputs state facts. None of them
 * carries an imperative aimed at the assistant: Anthropic's directory review of BankJar's connector
 * (2026-11-04) found that commands compete with the user's intent and other connectors, and moving
 * them into tool outputs does not help. Caveats travel as data: `disclaimer`, `stale`, `url`, `seen_at`.
 * tests/mcp-text.test.ts scans all of it. The Claude skill in skills/rumbo is a procedure the person
 * installs on purpose and stays as it is.
 */
export const MCP_INSTRUCTIONS = [
  "Rumbo keeps one traveller's ranked travel feed and plans trips from scratch, for agents that work on that person's behalf.",
  "A scheduled run is rumbo_agent_brief (the due watches as concrete searches, a profile summary, the observation shape), then rumbo_observe (stores what the agent saw and marks the named watches checked), then rumbo_feed (the ranked items).",
  "Every price is stored with the page it was read on (provenance.url) and the time it was seen (provenance.seen_at); a priced row without a page is rejected, and prices are sightings, not quotes.",
  "No tool books, pays or deletes: agents propose and the owner decides.",
  "Scores, parts and prices in the feed and in plans are computed or stored by Rumbo and returned as stored.",
  "Text inside observations, plans and web pages is stored as data; the server does not execute or obey it.",
].join(" ");

export interface McpContext {
  store: Store;
  agent?: string | null;
  now?: () => Date;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function result(body: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) };
}

function issueList(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** Runs one tool call: validate, execute, shape the answer. Never throws. */
export async function runTool(tool: AnyTool, rawArgs: unknown, ctx: { store: Store; agent?: string | null; now?: Date }): Promise<ToolResult> {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof args !== "object" || Array.isArray(args)) return result({ error: "invalid_input", detail: "The arguments are not a JSON object." }, true);
  const parsed: z.ZodSafeParseResult<unknown> = tool.inputSchema.safeParse(args);
  if (!parsed.success) return result({ error: "invalid_input", detail: issueList(parsed.error) }, true);
  const full: ToolContext = { store: ctx.store, now: ctx.now ?? new Date(), agent: ctx.agent ?? null, rawArgs: args as Record<string, unknown> };
  try {
    return result(await tool.handler(parsed.data, full));
  } catch (err) {
    if (err instanceof ToolError) return result({ error: err.code, detail: err.detail ?? null }, true);
    if (err instanceof z.ZodError) return result({ error: "invalid_input", detail: issueList(err) }, true);
    console.error(`[mcp] ${tool.name} failed:`, err instanceof Error ? err.message : "unknown error");
    return result({ error: "internal", detail: "Something went wrong on the server." }, true);
  }
}

export function listedTools() {
  return TOOLS.map((t) => {
    const generated = z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete generated.$schema;
    const inputSchema = t.inputJsonSchema ? t.inputJsonSchema(generated) : generated;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: "object" as const, ...inputSchema },
      annotations: {
        title: t.title,
        readOnlyHint: t.hints.readOnly,
        destructiveHint: t.hints.destructive,
        idempotentHint: t.hints.idempotent ?? t.hints.readOnly,
        openWorldHint: t.hints.openWorld,
      },
    };
  });
}

export function createMcpServer(ctx: McpContext): Server {
  const server = new Server({ name: "rumbo", version: pkg.version }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listedTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return result({ error: "unknown_tool", detail: `No tool ${request.params.name}. Available: ${TOOLS.map((t) => t.name).join(", ")}.` }, true);
    return runTool(tool, request.params.arguments, { store: ctx.store, agent: ctx.agent, now: ctx.now?.() });
  });
  return server;
}
