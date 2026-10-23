import { ZodError } from "zod";
import { authorize } from "./auth";
import { errorResponse, jsonResponse } from "./http";
import { apiLimiter } from "./ratelimit";
import { store, type Store } from "./store";

/**
 * The wrapper every /api/v1 route uses: owner check, per-key rate limit, JSON errors in one shape
 * `{ error, detail }`. A handler returns a Response or a plain object (sent as 200 JSON), and may
 * throw `ApiError` or a ZodError.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: unknown,
  ) {
    super(code);
  }
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large", `Bodies are limited to ${MAX_BODY_BYTES} bytes.`);
  if (!text.trim()) throw new ApiError(400, "invalid_json", "The request body is empty.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function zodDetail(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export type Handler<P> = (request: Request, ctx: { params: P; store: Store }) => Promise<Response | unknown> | Response | unknown;

export function route<P = Record<string, never>>(handler: Handler<P>) {
  return async (request: Request, ctx?: { params?: Promise<P> }): Promise<Response> => {
    const auth = authorize(request);
    if (!auth.ok) return auth.response;
    if (!apiLimiter().take(auth.principal)) {
      return errorResponse(429, "rate_limited", "Too many requests. Slow down.", { "Retry-After": "60" });
    }
    try {
      const params = (ctx?.params ? await ctx.params : {}) as P;
      const out = await handler(request, { params, store: store() });
      return out instanceof Response ? out : jsonResponse(out);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err.status, err.code, err.detail);
      if (err instanceof ZodError) return errorResponse(400, "invalid_body", zodDetail(err));
      console.error("[api] unhandled", err);
      return errorResponse(500, "internal", "Something went wrong on the server.");
    }
  };
}
