"use client";

import { useState, useTransition } from "react";
import { revealKeyAction } from "../app/(app)/agents/actions";

/**
 * The /mcp/<key> URL with the key masked. The key is fetched by a server action only when you
 * click Reveal, so it is not in the page HTML. Hidden again after 30 seconds.
 */
export function KeyReveal({ base }: { base: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  function reveal() {
    setError("");
    start(async () => {
      const result = await revealKeyAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setKey(result.key);
      setTimeout(() => setKey(null), 30_000);
    });
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(`${base}/mcp/${key}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed. Select the URL and copy it by hand.");
    }
  }

  return (
    <div className="stack-sm">
      <pre tabIndex={0} aria-label="MCP URL with the key">
        <code>{`${base}/mcp/${key ?? "••••••••••••••••"}`}</code>
      </pre>
      <div className="row">
        {key ? (
          <>
            <button type="button" className="btn btn-sm" onClick={copy}>
              {copied ? "Copied" : "Copy URL"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setKey(null)}>
              Hide
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={reveal} disabled={pending}>
            {pending ? "Revealing…" : "Reveal key"}
          </button>
        )}
        <span className="t-caption muted">Anyone with this URL can read and write your feed. Keep it out of screenshots and chats.</span>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
