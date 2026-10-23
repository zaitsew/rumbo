import type { Metadata } from "next";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <>
      <div>
        <h1 className="t-title">Agents</h1>
        <p className="muted">Claude, Codex, ChatGPT and Grok will plug into Rumbo here.</p>
      </div>
      <section className="card">
        <h2 className="t-sub">The MCP endpoint is coming</h2>
        <p>
          A remote MCP server at <code>/mcp</code> will let your AI tools read the feed, post what they find and update your profile.
          Until then the JSON API works with your owner key:
        </p>
        <pre>{`curl -H "Authorization: Bearer $RUMBO_OWNER_KEY" \\
  ${"<this site>"}/api/v1/observations`}</pre>
        <p className="t-caption muted">Agents propose; you decide. No tool books or pays.</p>
      </section>
    </>
  );
}
