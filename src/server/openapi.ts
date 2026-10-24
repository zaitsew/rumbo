import { z } from "zod";
import pkg from "../../package.json";
import { FeedbackSchema, ObservationSchema, PastTripSchema, WatchSchema } from "../core/schema";
import { ProfilePatchSchema } from "./profile-merge";

/**
 * The OpenAPI 3.1 document of `/api/v1`, for ChatGPT GPT actions and Grok. It lists what an agent may
 * do (D4): read, add, react. There is no delete route and no whole-profile replace here, because an
 * agent proposes and the owner decides. Component schemas come from the shared zod schemas, so they
 * cannot drift from what the server accepts. Descriptions stay under 300 characters (GPT actions limit).
 */

type Json = Record<string, unknown>;

function schemaOf(s: z.ZodType, io: "input" | "output" = "input"): Json {
  const out = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
}

/** The observation schema with `id` optional in every variant: the server derives it. */
function observationInput(): Json {
  const out = schemaOf(ObservationSchema);
  const variants = (out.oneOf ?? out.anyOf) as Json[] | undefined;
  for (const v of variants ?? []) {
    if (Array.isArray(v.required)) v.required = (v.required as string[]).filter((r) => r !== "id");
  }
  return out;
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json): Json => ({ "application/json": { schema } });
const ok = (description: string, schema: Json = { type: "object" }): Json => ({ description, content: json(schema) });
const body = (schema: Json): Json => ({ required: true, content: json(schema) });
const query = (name: string, description: string, schema: Json, required = false): Json => ({ name, in: "query", required, description, schema });

const ERRORS: Json = {
  "400": { description: "Invalid input. Body is { error, detail }.", content: json(ref("Error")) },
  "401": { description: "Missing or wrong owner key.", content: json(ref("Error")) },
  "429": { description: "Too many requests or too many wrong keys.", content: json(ref("Error")) },
};

export function buildOpenApi(baseUrl: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Rumbo API",
      version: pkg.version,
      summary: "Personal travel feed and trip planner for one owner, used by AI agents.",
      description:
        "Rumbo ranks travel observations (flights, stays, cars, activities, events, ideas) for one owner. Agents read the feed, post what they found with its source page, and react. " +
        "Agents propose, the owner decides: nothing here books, pays or deletes. Prices must come from a page or tool result you saw; never estimate.",
    },
    servers: [{ url: baseUrl }],
    security: [{ ownerKey: [] }],
    paths: {
      "/api/v1/feed": {
        get: {
          operationId: "getFeed",
          summary: "Ranked travel feed, best first",
          description: "Items with score 0..1, its parts (deal, fit, taste, urgency, novelty) and short reasons. Report the numbers as given.",
          parameters: [
            query("limit", "How many items, 1 to 200. Default 30.", { type: "integer", minimum: 1, maximum: 200 }),
            query("kinds", "Comma list: flight,stay,car,activity,event,idea.", { type: "string" }),
            query("include_stale", "1 to include expired or past items.", { type: "string", enum: ["0", "1"] }),
          ],
          responses: { "200": ok("Ranked items."), ...ERRORS },
        },
      },
      "/api/v1/feedback": {
        post: {
          operationId: "sendFeedback",
          summary: "Record the owner's reaction to an item",
          description: "Only when the owner said so. dismissed and booked remove the item from the feed.",
          requestBody: body(ref("Feedback")),
          responses: { "201": ok("Saved."), "404": { description: "Unknown observation.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
      "/api/v1/profile": {
        get: {
          operationId: "getProfile",
          summary: "The owner's travel profile",
          description: "Home airports, interests, budgets, free windows, busy days, wishlist, agent notes. Null if none yet.",
          responses: { "200": ok("The profile."), ...ERRORS },
        },
        patch: {
          operationId: "updateProfile",
          summary: "Add facts to the profile",
          description: "Merges: objects merge, lists are unioned, scalars replaced; nothing is removed. `note` is kept with your agent name and time.",
          requestBody: body({
            type: "object",
            properties: {
              set: ref("ProfilePatch"),
              note: { type: "string", maxLength: 500, description: "One fact, e.g. prefers aisle seats." },
              agent: { type: "string", maxLength: 40, description: "Your agent name." },
            },
          }),
          responses: { "200": ok("The merged profile and what changed."), ...ERRORS },
        },
      },
      "/api/v1/watches": {
        get: { operationId: "listWatches", summary: "Searches Rumbo keeps checking", description: "Routes, anywhere scans and place watches.", responses: { "200": ok("Watches."), ...ERRORS } },
        post: {
          operationId: "addWatch",
          summary: "Propose a watch",
          description: "The owner can switch it off. Set created_by to your agent name. Add one only if the owner asked for it.",
          requestBody: body(ref("Watch")),
          responses: { "201": ok("Created."), ...ERRORS },
        },
      },
      "/api/v1/brief": {
        get: {
          operationId: "getAgentBrief",
          summary: "What a scheduled run should do now",
          description: "Due watches as concrete searches, the profile summary, the exact observation shapes with examples, and the rules. Changes nothing. Call first in every run.",
          parameters: [
            query("agent", "Your agent name, e.g. grok-task.", { type: "string", maxLength: 40 }, true),
            query("connectors", "Comma list of connectors you can use, e.g. Booking.com,Viator.", { type: "string" }),
          ],
          responses: { "200": ok("The brief."), ...ERRORS },
        },
      },
      "/api/v1/observations": {
        get: {
          operationId: "listObservations",
          summary: "Stored observations, newest first",
          description: "Raw observations, unranked. Use getFeed for the ranked view.",
          parameters: [
            query("kinds", "Comma list of kinds.", { type: "string" }),
            query("since", "ISO 8601 instant.", { type: "string" }),
            query("limit", "Positive integer.", { type: "integer", minimum: 1 }),
            query("include_stale", "1 to include expired.", { type: "string", enum: ["0", "1"] }),
          ],
          responses: { "200": ok("Observations."), ...ERRORS },
        },
        post: {
          operationId: "postObservations",
          summary: "Report what you found",
          description:
            "Up to 200 rows, checked one by one: bad rows come back in `rejected`. A price needs provenance.url (the page you read it on) and seen_at. Never estimate. Pass checked_watch_ids for watches you searched.",
          requestBody: body({
            type: "object",
            required: ["observations"],
            properties: {
              agent: { type: "string", maxLength: 40, description: "Your agent name." },
              observations: { type: "array", maxItems: 200, items: ref("ObservationInput") },
              checked_watch_ids: { type: "array", maxItems: 50, items: { type: "string" }, description: "Watches you searched, found or not." },
            },
          }),
          responses: { "200": ok("{ accepted, inserted, updated, skipped_older, rejected, watches_marked }"), "413": { description: "Too many rows.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
      "/api/v1/history": {
        post: {
          operationId: "importHistory",
          summary: "Save past trips",
          description: "One trip or an array of up to 200, upserted by id. All or nothing. Tags come from the interest list.",
          requestBody: body({ type: "array", maxItems: 200, items: ref("PastTrip") }),
          responses: { "200": ok("{ accepted }"), ...ERRORS },
        },
        put: {
          operationId: "replaceHistorySource",
          summary: "Replace one source's past trips",
          description: "The body is the source's WHOLE history (up to 2000 trips, each with that `source`). Rows that source sent before are replaced; other sources are untouched. Loco's server uses it with ?source=loco.",
          parameters: [query("source", "The source whose rows are replaced, e.g. loco.", { type: "string" }, true)],
          requestBody: body({ type: "array", maxItems: 2000, items: ref("PastTrip") }),
          responses: { "200": ok("{ accepted, removed }"), "409": { description: "An id belongs to another source's trip; nothing changed.", content: json(ref("Error")) }, "413": { description: "Too many rows.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
      "/api/v1/profile/busy": {
        put: {
          operationId: "replaceBusySource",
          summary: "Replace one source's busy windows",
          description: "The body is the source's WHOLE list of busy days [{from, to, what?}]. Windows tagged with the source (\"… (Loco)\") are replaced; the owner's own stay. An empty array clears them.",
          parameters: [query("source", "Only loco for now.", { type: "string", enum: ["loco"] }, true)],
          requestBody: body({ type: "array", maxItems: 500, items: { type: "object", required: ["from", "to"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, what: { type: "string" } } } }),
          responses: { "200": ok("{ busy, removed }"), "409": { description: "No profile yet.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
      "/api/v1/plans": { get: { operationId: "listPlans", summary: "Saved trip plans", description: "Plans the owner started, newest first.", responses: { "200": ok("Plans."), ...ERRORS } } },
      "/api/v1/plans/{id}": {
        get: {
          operationId: "getPlan",
          summary: "One plan",
          description: "Candidates, chosen place, dates, observation ids by section and deep links.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Plan id." }],
          responses: { "200": ok("The plan."), "404": { description: "No such plan.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
      "/api/v1/plans/{id}/loco": {
        get: {
          operationId: "getPlanAsLocoProposal",
          summary: "A plan as arguments for Loco's loco_propose",
          description: "You call Loco's loco_propose with the result. Rumbo sends nothing and books nothing.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Plan id." },
            query("trip_slug", "Slug of the Loco trip.", { type: "string" }),
            query("trip_id", "Id of the Loco trip.", { type: "string" }),
          ],
          responses: { "200": ok("{ loco_propose_args }"), "404": { description: "No such plan.", content: json(ref("Error")) }, ...ERRORS },
        },
        post: {
          operationId: "sendPlanToLoco",
          summary: "A plan as loco_propose arguments, marked sent to Loco",
          description: "For the caller about to make the loco_propose call (Loco's server). Same answer as GET; a ready plan becomes sent-to-loco. 409 until a place is chosen. Nothing is booked.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Plan id." },
            query("trip_slug", "Slug of the Loco trip.", { type: "string" }),
            query("trip_id", "Id of the Loco trip.", { type: "string" }),
          ],
          responses: { "200": ok("{ loco_propose_args, status }"), "404": { description: "No such plan.", content: json(ref("Error")) }, "409": { description: "No place chosen yet, or archived.", content: json(ref("Error")) }, ...ERRORS },
        },
      },
    },
    components: {
      securitySchemes: { ownerKey: { type: "http", scheme: "bearer", description: "The owner key (RUMBO_OWNER_KEY) as a bearer token." } },
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, detail: {} } },
        Feedback: schemaOf(FeedbackSchema),
        Watch: schemaOf(WatchSchema),
        PastTrip: schemaOf(PastTripSchema),
        ProfilePatch: schemaOf(ProfilePatchSchema),
        ObservationInput: observationInput(),
      },
    },
  };
}
