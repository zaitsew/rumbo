import { randomUUID } from "node:crypto";
import { z } from "zod";
import { INTERESTS, ProfileSchema, WatchSchema, type Profile, type Watch } from "../core/schema";
import { toMinor } from "../../components/format";

/** HTML form data to the shared schemas. Pure, so it is tested without a browser. */

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

function text(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function list(value: string, upper = false): string[] {
  const items = value.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  return upper ? items.map((s) => s.toUpperCase()) : items;
}

function num(fd: FormData, name: string): number | undefined {
  const v = text(fd, name);
  if (!v) return undefined;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; ");
}

/** One line per window: `2026-12-05 2026-12-09 optional note`. */
export function parseWindows(value: string): { from: string; to: string; note?: string }[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [from = "", to = "", ...rest] = line.split(/\s+/);
      const note = rest.join(" ");
      return note ? { from, to, note } : { from, to };
    });
}

export function formatWindows(windows: Profile["free_windows"]): string {
  return windows.map((w) => [w.from, w.to, w.note].filter(Boolean).join(" ")).join("\n");
}

/** Merges the form onto `existing`, so notes and busy days (which the form does not show) survive. */
export function parseProfileForm(fd: FormData, existing: Profile | null): FormResult<Profile> {
  const currency = (text(fd, "currency") || "EUR").toUpperCase();

  const interests: Record<string, number> = {};
  for (const key of INTERESTS) {
    const n = num(fd, `interest_${key}`);
    if (n !== undefined && n !== 0) interests[key] = n;
  }

  const money = (name: string) => {
    const n = num(fd, name);
    return n === undefined ? undefined : { amount_minor: toMinor(n, currency), currency };
  };

  const candidate = {
    ...(existing ?? {}),
    name: text(fd, "name") || undefined,
    home_city: text(fd, "home_city"),
    home_airports: list(text(fd, "home_airports"), true),
    currency,
    languages: list(text(fd, "languages")),
    travellers: { adults: num(fd, "adults") ?? 1, children: num(fd, "children") ?? 0 },
    interests,
    budget: { flight_max: money("flight_max"), night_max: money("night_max") },
    flight: {
      max_stops: num(fd, "max_stops") ?? 1,
      max_hours_one_way: num(fd, "max_hours_one_way") ?? 8,
      earliest_departure: text(fd, "earliest_departure") || undefined,
      avoid_airlines: list(text(fd, "avoid_airlines")),
      preferred_airlines: list(text(fd, "preferred_airlines")),
    },
    stay: {
      kinds: fd.getAll("stay_kind").filter((v): v is string => typeof v === "string"),
      min_rating: num(fd, "min_rating"),
    },
    free_windows: parseWindows(text(fd, "free_windows")),
    wishlist: list(text(fd, "wishlist")),
  };

  const parsed = ProfileSchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: issues(parsed.error) };
}

export function parseProfileJson(raw: string): FormResult<Profile> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = ProfileSchema.safeParse(data);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: issues(parsed.error) };
}

export function parseWatchForm(fd: FormData, currency: string): FormResult<Watch> {
  const kind = text(fd, "kind");
  const place = text(fd, "place");
  const origin = list(text(fd, "origin"), true);
  const destination = list(text(fd, "destination"), true);
  const nMin = num(fd, "nights_min");
  const nMax = num(fd, "nights_max");
  const price = num(fd, "max_price");

  if (kind === "route" && destination.length === 0) return { ok: false, error: "A route watch needs at least one destination airport." };
  if (kind.startsWith("place-") && !place) return { ok: false, error: "A place watch needs a city." };
  if ((nMin === undefined) !== (nMax === undefined)) return { ok: false, error: "Give both minimum and maximum nights, or neither." };

  const label =
    text(fd, "label") ||
    (kind === "route" ? `${origin.join("/") || "Home"} to ${destination.join("/")}` : kind === "anywhere" ? "Anywhere" : `${place} ${kind.replace("place-", "")}`);

  const parsed = WatchSchema.safeParse({
    id: `w_${randomUUID().slice(0, 8)}`,
    kind,
    label,
    origin,
    destination: kind === "route" ? destination : [],
    place: kind.startsWith("place-") ? place : undefined,
    window: { from: text(fd, "window_from"), to: text(fd, "window_to") },
    nights: nMin !== undefined && nMax !== undefined ? { min: nMin, max: nMax } : undefined,
    max_price: price === undefined ? undefined : { amount_minor: toMinor(price, currency), currency },
    every_hours: num(fd, "every_hours") ?? 24,
    active: true,
    created_by: "owner",
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  if (parsed.data.window.to < parsed.data.window.from) return { ok: false, error: "The window ends before it starts." };
  return { ok: true, value: parsed.data };
}
