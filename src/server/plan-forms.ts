import { INTERESTS, InterestSchema, type PlanRequest } from "../core/schema";
import { toMinor } from "../../components/format";
import type { FormResult } from "./forms";
import type { StartInput, TripDates } from "./plan";

/** The planner's HTML forms to the inputs of `startPlan` and `choosePlace`. Pure, so tests need no browser. */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function int(fd: FormData, name: string): number | undefined | null {
  const v = text(fd, name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function parsePlanForm(fd: FormData, currency: string): FormResult<StartInput> {
  const sentence = text(fd, "text").slice(0, 1000);
  const request: Partial<PlanRequest> = {};

  const from = text(fd, "window_from");
  const to = text(fd, "window_to");
  if (from || to) {
    if (!DAY.test(from) || !DAY.test(to)) return { ok: false, error: "Give both dates, or neither." };
    if (to < from) return { ok: false, error: "The window cannot end before it starts." };
    request.window = { from, to };
  }

  const min = int(fd, "nights_min");
  const max = int(fd, "nights_max");
  if (min === null || max === null || (min !== undefined && min < 1) || (max !== undefined && max < 1)) return { ok: false, error: "Nights must be whole numbers, 1 or more." };
  if (min !== undefined || max !== undefined) {
    const lo = min ?? max!;
    const hi = max ?? min!;
    if (hi < lo) return { ok: false, error: "The most nights cannot be below the fewest." };
    request.nights = { min: lo, max: hi };
  }

  const adults = int(fd, "adults");
  const children = int(fd, "children");
  if (adults === null || children === null || (adults !== undefined && adults < 1) || (children !== undefined && children < 0)) return { ok: false, error: "Travellers must be whole numbers; at least one adult." };
  if (adults !== undefined || children !== undefined) request.travellers = { adults: adults ?? 1, children: children ?? 0 };

  const budget = text(fd, "budget");
  if (budget) {
    const n = Number(budget.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "The budget must be a positive number." };
    request.budget_total = { amount_minor: toMinor(n, currency), currency };
  }

  const picked = fd.getAll("interest").filter((v): v is string => typeof v === "string" && InterestSchema.safeParse(v).success);
  if (picked.length) request.interests = INTERESTS.filter((i) => picked.includes(i));

  const destination = text(fd, "destination");
  if (destination) request.destination = destination.slice(0, 80);
  if (fd.get("car") === "on") request.needs = ["flights", "stay", "car", "activities", "events"];

  if (!sentence && Object.keys(request).length === 0) return { ok: false, error: "Describe the trip, or fill in at least one field." };
  return { ok: true, value: { ...(sentence ? { text: sentence } : {}), ...(Object.keys(request).length ? { request } : {}) } };
}

export function parseChooseForm(fd: FormData): FormResult<{ id: string; place: string; dates?: TripDates }> {
  const id = text(fd, "id");
  const place = text(fd, "place");
  if (!id || !place) return { ok: false, error: "Choose a place." };
  const from = text(fd, "from");
  const to = text(fd, "to");
  if (!from && !to) return { ok: true, value: { id, place } };
  if (!DAY.test(from) || !DAY.test(to)) return { ok: false, error: "Give both dates, or neither." };
  return { ok: true, value: { id, place, dates: { from, to } } };
}
