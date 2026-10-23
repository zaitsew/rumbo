/** Response helpers shared by every route handler. Errors are always `{ error, detail }`. */

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

/** `error` is a stable machine code ("invalid_body"); `detail` is for a person or an agent to read. */
export function errorResponse(status: number, error: string, detail?: unknown, headers?: Record<string, string>): Response {
  return jsonResponse({ error, detail: detail ?? null }, { status, headers });
}
