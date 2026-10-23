/**
 * The public base URL, for snippets and documents that tell a person or an agent where Rumbo is.
 * `RUMBO_PUBLIC_URL` wins. Otherwise the host the visitor used, taken from the forwarded headers
 * Caddy sets. The host only ever shapes text; no access decision reads it.
 */

const HOST_OK = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export function siteUrl(headers?: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.RUMBO_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (fixed && /^https?:\/\/[^\s/]+$/i.test(fixed)) return fixed;
  const host = (headers?.get("x-forwarded-host") ?? headers?.get("host") ?? "").split(",")[0]?.trim() ?? "";
  if (!host || !HOST_OK.test(host)) return "http://localhost:3000";
  const proto = headers?.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const local = /^(localhost|127\.0\.0\.1)(:|$)/i.test(host);
  return `${proto === "http" || proto === "https" ? proto : local ? "http" : "https"}://${host}`;
}
