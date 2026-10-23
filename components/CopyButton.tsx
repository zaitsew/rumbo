"use client";

import { useState } from "react";

/** Copies `text` to the clipboard. If the browser refuses, the text stays selectable in the box next to it. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }
  return (
    <button type="button" className="btn btn-sm" onClick={copy} aria-live="polite">
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed: select the text" : label}
    </button>
  );
}
