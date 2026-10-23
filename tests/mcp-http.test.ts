import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";

const KEY = "owner-key-with/odd+chars";
const ENC = encodeURIComponent(KEY);
const tmp = tempDir();

type Handler = (req: Request, ctx?: { params: Promise<{ key: string }> }) => Promise<Response>;
let bearer: { POST: Handler; GET: Handler; DELETE: Handler };
let pathed: { POST: Handler; GET: Handler; DELETE: Handler };
let reset: () => void;
let closeDb: () => void;

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method: string, params: unknown = {}, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

function viaBearer(body: string, key: string | null = KEY, extra: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/mcp", { method: "POST", headers: { ...HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra }, body });
}
function viaPath(body: string, key: string, extra: Record<string, string> = {}, search = ""): [Request, { params: Promise<{ key: string }> }] {
  return [
    new Request(`http://localhost:3000/mcp/${encodeURIComponent(key)}${search}`, { method: "POST", headers: { ...HEADERS, ...extra }, body }),
    { params: Promise.resolve({ key: encodeURIComponent(key) }) },
  ];
}
const ip = (n: string) => ({ "x-forwarded-for": n });

beforeAll(async () => {
  process.env.RUMBO_DB = tmp.path;
  process.env.RUMBO_OWNER_KEY = KEY;
  process.env.RUMBO_TRUST_PROXY = "1";
  vi.resetModules();
  bearer = (await import("../app/mcp/route")) as unknown as typeof bearer;
  pathed = (await import("../app/mcp/[key]/route")) as unknown as typeof pathed;
  reset = () => void (globalThis as unknown as { __rumboLimiters?: Record<string, { reset(): void }> }).__rumboLimiters?.lockout?.reset();
  closeDb = (await import("../src/server/store")).closeDb;
});
afterAll(() => {
  closeDb();
  tmp.cleanup();
});
beforeEach(() => reset());

describe("/mcp with a bearer key", () => {
  it("serves tools/list to the owner and refuses everyone else with 401", async () => {
    const ok = await bearer.POST(viaBearer(rpc("tools/list")));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("rumbo_agent_brief");
    expect(names).toHaveLength(13);
    for (const t of body.result.tools) expect(t.inputSchema.type).toBe("object");
    const none = await bearer.POST(viaBearer(rpc("tools/list"), null));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthorized" });
    expect((await bearer.POST(viaBearer(rpc("tools/list"), "wrong"))).status).toBe(401);
  });

  it("initializes and runs a tool end to end, naming the agent from the header", async () => {
    const init = await bearer.POST(viaBearer(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })));
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("rumbo");

    const put = await bearer.POST(viaBearer(rpc("tools/call", { name: "rumbo_profile_update", arguments: { set: { home_city: "Valencia", home_airports: ["VLC"] }, note: "from the wire" } }), KEY, { "x-rumbo-agent": "codex-automation" }));
    const out = JSON.parse((await put.json()).result.content[0].text);
    expect(out.profile.notes[0].provenance.agent).toBe("codex-automation");

    const bad = await bearer.POST(viaBearer(rpc("tools/call", { name: "rumbo_feed", arguments: { limit: 9999 } })));
    const res = (await bad.json()).result;
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("invalid_input");

    const unknown = await bearer.POST(viaBearer(rpc("tools/call", { name: "rumbo_delete_everything", arguments: {} })));
    expect(JSON.parse((await unknown.json()).result.content[0].text).error).toBe("unknown_tool");
  });

  it("answers GET and DELETE with 405 once authenticated, and 401 before", async () => {
    const get = (key: string | null) => new Request("http://localhost:3000/mcp", { method: "GET", headers: { accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
    expect((await bearer.GET(get(KEY))).status).toBe(405);
    expect((await bearer.GET(get(null))).status).toBe(401);
    expect((await bearer.DELETE(new Request("http://localhost:3000/mcp", { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } }))).status).toBe(405);
  });
});

describe("/mcp/[key]", () => {
  it("accepts the key in the path (URL-encoded), refuses a wrong one, and takes the agent from ?agent=", async () => {
    const [okReq, okCtx] = viaPath(rpc("tools/call", { name: "rumbo_profile_update", arguments: { note: "via path" } }), KEY, {}, "?agent=chatgpt-task");
    const ok = await pathed.POST(okReq, okCtx);
    expect(ok.status).toBe(200);
    const text = (await ok.json()).result.content[0].text;
    expect(JSON.parse(text).profile.notes.at(-1).provenance.agent).toBe("chatgpt-task");

    const [badReq, badCtx] = viaPath(rpc("tools/list"), "not-the-key");
    expect((await pathed.POST(badReq, badCtx)).status).toBe(401);
    const [garbleReq] = viaPath(rpc("tools/list"), KEY);
    expect((await pathed.POST(garbleReq, { params: Promise.resolve({ key: "%E0%A4%A" }) })).status).toBe(401);
    const get = new Request(`http://localhost:3000/mcp/${ENC}`, { method: "GET", headers: { accept: "text/event-stream" } });
    const got = await pathed.GET(get, { params: Promise.resolve({ key: ENC }) });
    expect(got.status).toBe(405);
    expect(await got.text()).not.toContain(KEY);
  });

  it("applies the lockout to both forms, sharing one counter per client address", async () => {
    // Five wrong bearer keys and five wrong path keys from one address lock that address out.
    for (let i = 0; i < 5; i++) expect((await bearer.POST(viaBearer(rpc("tools/list"), "bad", ip("7.7.7.7")))).status).toBe(401);
    for (let i = 0; i < 5; i++) {
      const [r, c] = viaPath(rpc("tools/list"), `bad${i}`, ip("7.7.7.7"));
      expect((await pathed.POST(r, c)).status).toBe(401);
    }
    const locked = await bearer.POST(viaBearer(rpc("tools/list"), KEY, ip("7.7.7.7")));
    expect(locked.status).toBe(429);
    const [r, c] = viaPath(rpc("tools/list"), KEY, ip("7.7.7.7"));
    expect((await pathed.POST(r, c)).status).toBe(429);
    // Another address is unaffected, on both forms.
    expect((await bearer.POST(viaBearer(rpc("tools/list"), KEY, ip("8.8.8.8")))).status).toBe(200);
    const [r2, c2] = viaPath(rpc("tools/list"), KEY, ip("8.8.8.8"));
    expect((await pathed.POST(r2, c2)).status).toBe(200);
  });

  it("locks out a path-key guesser even when the guesses never use the bearer header", async () => {
    for (let i = 0; i < 10; i++) {
      const [r, c] = viaPath(rpc("tools/list"), `guess${i}`, ip("6.6.6.6"));
      expect((await pathed.POST(r, c)).status).toBe(401);
    }
    const [r, c] = viaPath(rpc("tools/list"), KEY, ip("6.6.6.6"));
    expect((await pathed.POST(r, c)).status).toBe(429);
  });

  it("never puts the key in a response body or a log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    try {
      const responses: Response[] = [];
      const [wrongReq, wrongCtx] = viaPath(rpc("tools/list"), KEY + "x");
      responses.push(await pathed.POST(wrongReq, wrongCtx));
      const [badJsonReq, badJsonCtx] = viaPath("{not json", KEY);
      responses.push(await pathed.POST(badJsonReq, badJsonCtx));
      const [toolErrReq, toolErrCtx] = viaPath(rpc("tools/call", { name: "rumbo_feed", arguments: { limit: -1 } }), KEY);
      responses.push(await pathed.POST(toolErrReq, toolErrCtx));
      const [bigReq, bigCtx] = viaPath("x".repeat(1_100_000), KEY);
      responses.push(await pathed.POST(bigReq, bigCtx));
      for (const r of responses) {
        const text = await r.text();
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(ENC);
      }
      expect(responses[3]!.status).toBe(413);
      for (const line of logs) {
        expect(line).not.toContain(KEY);
        expect(line).not.toContain(ENC);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("refuses everything with 503 when no owner key is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.RUMBO_OWNER_KEY;
    try {
      const [r, c] = viaPath(rpc("tools/list"), KEY);
      expect((await pathed.POST(r, c)).status).toBe(503);
      expect((await bearer.POST(viaBearer(rpc("tools/list")))).status).toBe(503);
    } finally {
      process.env.RUMBO_OWNER_KEY = KEY;
      warn.mockRestore();
    }
  });
});

describe("redact", () => {
  it("removes the raw and the encoded key", async () => {
    const { redact } = await import("../src/server/mcp/http");
    expect(redact(`failed at /mcp/${ENC} for ${KEY}`, KEY)).toBe("failed at /mcp/[redacted] for [redacted]");
    expect(redact("nothing here", null)).toBe("nothing here");
  });
});
