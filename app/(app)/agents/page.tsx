import type { Metadata } from "next";
import { headers } from "next/headers";
import { CopyBlock } from "../../../components/CopyBlock";
import { KeyReveal } from "../../../components/KeyReveal";
import { formatStamp } from "../../../components/format";
import { recentAgentActivity } from "../../../src/server/agents";
import { TOOLS } from "../../../src/server/mcp/tools";
import { siteUrl } from "../../../src/server/site";
import { store } from "../../../src/server/store";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

function Status({ verified }: { verified: boolean }) {
  return <span className={`chip ${verified ? "chip-good" : "chip-warn"}`}>{verified ? "checked against the server" : "unverified"}</span>;
}

export default async function AgentsPage() {
  const base = siteUrl(await headers());
  const activity = recentAgentActivity(store(), 20);
  const total = activity.reduce((n, a) => n + a.count, 0);

  return (
    <>
      <div>
        <h1 className="t-title">Agents</h1>
        <p className="muted">
          Connect your AI tools to Rumbo. They read your brief, search with their own connectors, and post what they saw. Rumbo ranks it.
          No tool books, pays or deletes: agents propose, you decide.
        </p>
      </div>

      <section className="card" aria-labelledby="claude-code">
        <div className="row row-between">
          <h2 id="claude-code" className="t-sub">
            Claude Code
          </h2>
          <Status verified={false} />
        </div>
        <p>
          One command, key typed in the header (the key lands in <code>~/.claude.json</code>):
        </p>
        <CopyBlock label="Claude Code command" text={`claude mcp add --transport http rumbo ${base}/mcp --header "Authorization: Bearer $RUMBO_KEY"`} />
        <p>
          Better: <code>scripts/install-claude.sh</code> keeps the key in the macOS Keychain and registers a headers helper, so no secret is in the config. It also links the <code>rumbo</code> skill.
        </p>
        <CopyBlock label="Claude Code installer" text={`scripts/install-claude.sh --dry-run\nscripts/install-claude.sh --url ${base}`} />
      </section>

      <section className="card" aria-labelledby="claude-app">
        <div className="row row-between">
          <h2 id="claude-app" className="t-sub">
            Claude desktop and claude.ai
          </h2>
          <Status verified={false} />
        </div>
        <ol className="agent-steps">
          <li>Settings, Connectors, Add custom connector.</li>
          <li>Paste this URL (the key is part of the path):</li>
        </ol>
        <KeyReveal base={base} />
        <p className="t-caption muted">
          For a daily run, create a scheduled task at 07:30 Europe/Madrid with the prompt in <code>routines/agents/claude-scheduled-task.md</code>.
        </p>
      </section>

      <section className="card" aria-labelledby="codex">
        <div className="row row-between">
          <h2 id="codex" className="t-sub">
            Codex
          </h2>
          <Status verified={false} />
        </div>
        <p>
          Add to <code>~/.codex/config.toml</code> and export <code>RUMBO_KEY</code>, or run <code>scripts/install-codex.sh</code>:
        </p>
        <CopyBlock
          label="Codex config"
          text={`[mcp_servers.rumbo]\nurl = "${base}/mcp"\nbearer_token_env_var = "RUMBO_KEY"`}
        />
        <CopyBlock label="Codex installer" text={`scripts/install-codex.sh --dry-run\nscripts/install-codex.sh --url ${base} --daily`} />
        <p className="t-caption muted">The Codex desktop app does not see shell variables when started from the Dock; use <code>--helper</code>.</p>
      </section>

      <section className="card" aria-labelledby="chatgpt">
        <div className="row row-between">
          <h2 id="chatgpt" className="t-sub">
            ChatGPT
          </h2>
          <Status verified={false} />
        </div>
        <p>
          Developer-mode connector: Settings, Connectors, Advanced, Developer mode, add a connector with the <code>/mcp/&lt;key&gt;</code> URL above and authentication none.
          On some plans connectors are read-only; then use a custom GPT action.
        </p>
        <p>Custom GPT action: import this schema and set authentication to API key, Bearer, with your owner key.</p>
        <CopyBlock label="OpenAPI URL" text={`${base}/openapi.json`} />
      </section>

      <section className="card" aria-labelledby="grok">
        <div className="row row-between">
          <h2 id="grok" className="t-sub">
            Grok
          </h2>
          <Status verified={false} />
        </div>
        <p>
          The xAI API supports remote MCP tools. Whether grok.com Tasks can attach one is unconfirmed, so the JSON API is the safe path:
        </p>
        <CopyBlock
          label="Grok JSON API"
          text={`curl -H "Authorization: Bearer $RUMBO_KEY" "${base}/api/v1/brief?agent=grok-task"\ncurl -H "Authorization: Bearer $RUMBO_KEY" "${base}/api/v1/feed?limit=5"`}
        />
      </section>

      <section className="card" aria-labelledby="any">
        <h2 id="any" className="t-sub">
          Any other agent
        </h2>
        <p>
          Machine-readable docs: <a href="/llms.txt">/llms.txt</a>, <a href="/openapi.json">/openapi.json</a>. Quick check of the MCP endpoint:
        </p>
        <CopyBlock
          label="MCP tools/list"
          text={`curl -s ${base}/mcp \\\n  -H "Authorization: Bearer $RUMBO_KEY" \\\n  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
        />
      </section>

      <section aria-labelledby="tools">
        <h2 id="tools" className="t-sub">
          The {TOOLS.length} MCP tools
        </h2>
        <ul className="t-caption grid gap-1">
          {TOOLS.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>: {t.description.split(". ")[0]!.replace(/\.$/, "")}.
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="activity">
        <h2 id="activity" className="t-sub">
          Recent activity
        </h2>
        {activity.length === 0 ? (
          <div className="empty">No agent has posted yet. Run one of the setups above, then look here.</div>
        ) : (
          <>
            <p className="t-caption muted">
              The last {total} observations, grouped by the agent that posted them.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Items</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.agent}>
                      <th scope="row">{a.agent}</th>
                      <td className="num">{a.count}</td>
                      <td>{formatStamp(a.last_seen_at)}</td>
                      <td>{a.sources.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}
