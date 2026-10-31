import type { z } from "zod";
import type { Store } from "../store";

/**
 * A tool is a plain object: `{ name, description, inputSchema, handler }`. The registry in
 * `tools/index.ts` lists them and `server.ts` serves them, so a new lane adds a tool by adding a
 * file in `tools/` and one line in that index. No tool deletes, books or pays (D4).
 */

/** Thrown by a handler; becomes `{ error, detail }` with `isError: true`. */
export class ToolError extends Error {
  constructor(
    public code: string,
    public detail?: unknown,
  ) {
    super(code);
  }
}

export interface ToolContext {
  store: Store;
  now: Date;
  /** The agent named in the request (X-Rumbo-Agent header or ?agent=), if any. */
  agent: string | null;
  /** The arguments exactly as the client sent them, before zod filled in defaults. */
  rawArgs: Record<string, unknown>;
}

/**
 * What a client may assume about a call. Every tool states all three, so a directory reviewer and an
 * agent never read a default. `destructive` is true when a call can overwrite a stored value (the MCP
 * meaning: not purely additive); nothing here deletes. `openWorld` is true when the tool itself calls
 * outside services.
 */
export interface ToolHints {
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
  /** Repeating the same call changes nothing more. Defaults to `readOnly`. */
  idempotent?: boolean;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Shown to clients as the tool's annotations. */
  hints: ToolHints;
  /** Adjust the JSON Schema listed to clients (for fields validated row by row). */
  inputJsonSchema?: (generated: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: z.output<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

export function defineTool<S extends z.ZodType>(tool: ToolDef<S>): ToolDef<S> {
  return tool;
}

/** The agent's own name wins, then the one in the request, then a neutral label. */
export function agentName(given: string | undefined, ctx: ToolContext): string {
  const name = (given?.trim() || ctx.agent || "agent").slice(0, 40);
  // The name is stored and echoed to other agents, so it is a label, not free text (tests/security/injection.test.ts).
  if (!AGENT_OK.test(name)) throw new ToolError("invalid_agent", "Agent names use letters, digits and : _ . - only (for example claude-scheduled).");
  if (isReservedAgent(name)) throw new ToolError("reserved_agent", `"${name}" is the owner's name; pick your own agent name (for example claude-scheduled).`);
  return name;
}

/** `created_by: "owner"` marks what the owner made. No agent may sign as the owner. */
export function isReservedAgent(name: string): boolean {
  return name.trim().toLowerCase() === "owner";
}

const AGENT_OK = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,39}$/;
export function cleanAgent(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && AGENT_OK.test(v) && !isReservedAgent(v) ? v : null;
}
