"use client";

import { useState } from "react";

/** A code block with a copy button. The text is shown as given; nothing secret is passed here. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="copyblock">
      <pre tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <button type="button" className="btn btn-sm" onClick={copy} aria-label={`Copy ${label}`}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
    </div>
  );
}
