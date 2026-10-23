import { INTERESTS, type Interest, type PlanRequest, type Profile } from "./schema";
import { dayMs, msToDay } from "./money";

/**
 * Free text to a `Partial<PlanRequest>`: rules only, no I/O, no model. English, Spanish and Russian.
 *
 * It fills only what the person said (dates, length, party, budget, interests, a destination, a car) and
 * leaves everything else out, so a caller can tell "not said" from "default". Defaults come from the
 * profile in `src/server/plan.ts`. The AI step (`src/server/ai.ts`) runs when `confidence` is low and
 * may fill only the fields this parser left out.
 *
 * Choices that are not obvious, all pinned by tests/plan-parse.test.ts:
 *  - "N days" means a trip of N days: nights {N-1, N}. "N nights" is exact. "a week" is 7 nights.
 *  - "weekend" is Friday to Sunday (2 nights); "long weekend" is Friday to Monday (3 nights).
 *    "this weekend" on a Saturday or Sunday is the coming one.
 *  - A month with no year is its next occurrence; the current month runs from today, unless it is
 *    past the 25th, when it means next year.
 *  - An explicit range ("5-9 December") sets the window and the nights.
 *  - Money is read only next to a currency or after a budget word, so "3 nights" is never a budget.
 */

export interface KnownPlace {
  place: string;
  country: string;
}

export interface ParsedPlan {
  request: Partial<PlanRequest>;
  /** 0..1: how much of a trip the sentence pinned down. Below 0.7 the AI step may help. */
  confidence: number;
  /** Names of the things not found among: "window", "nights", "interests". */
  missing: string[];
}

// --- text helpers ---------------------------------------------------------------------------------

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const re = (src: string, flags = "iu"): RegExp => new RegExp(src, flags);

/** Lower case, Latin accents and a few letters stripped; Cyrillic keeps its letters (except ё). */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/([a-z])[\u0300-\u036f]+/gi, "$1")
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .replace(/ø/gi, "o")
    .replace(/ł/gi, "l")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/[–—−]/g, "-")
    .replace(/[’‘´`]/g, "'")
    .replace(/\u00a0/g, " ")
    .toLowerCase();
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  один: 1, одна: 1, одну: 1, одно: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5,
  шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10, пару: 2, пара: 2, двое: 2, трое: 3, четверо: 4,
};
const ARTICLES = new Set(["a", "an", "un", "una"]);
const alt = (words: string[]): string => words.sort((x, y) => y.length - x.length).join("|");
/** A number: digits or a word. NUM_N leaves out the articles, for places where "a" means something else. */
const NUM = String.raw`(\d{1,3}|${alt(Object.keys(WORD_NUMBERS))})`;
const NUM_N = String.raw`(\d{1,3}|${alt(Object.keys(WORD_NUMBERS).filter((w) => !ARTICLES.has(w)))})`;
const toNum = (tok: string | undefined): number | undefined => {
  if (!tok) return undefined;
  const t = tok.toLowerCase();
  return /^\d+$/.test(t) ? parseInt(t, 10) : WORD_NUMBERS[t];
};

// --- months, days -------------------------------------------------------------------------------

const MONTH_FULL: string[] = [
  String.raw`january|enero|январ[ьяе]`,
  String.raw`february|febrero|феврал[ьяе]`,
  String.raw`march|marzo|март[аеу]?`,
  String.raw`april|abril|апрел[ьяе]`,
  String.raw`may|mayo|ма[йяе]`,
  String.raw`june|junio|июн[ьяе]`,
  String.raw`july|julio|июл[ьяе]`,
  String.raw`august|agosto|август[аеу]?`,
  String.raw`september|septiembre|setiembre|сентябр[ьяе]`,
  String.raw`october|octubre|октябр[ьяе]`,
  String.raw`november|noviembre|ноябр[ьяе]`,
  String.raw`december|diciembre|декабр[ьяе]`,
];
const MONTH_ABBR: string[] = ["jan|ene", "feb", "mar", "apr|abr", "may", "jun", "jul", "aug|ago", "sept?", "oct", "nov", "dec|dic"];
const MON_FULL = MONTH_FULL.join("|");
const MON_ANY = `${MONTH_FULL.join("|")}|${MONTH_ABBR.join("|")}`;

function monthOf(token: string): number | undefined {
  const t = token.toLowerCase().replace(/\.$/, "");
  for (let i = 0; i < 12; i++) {
    if (re(`^(?:${MONTH_FULL[i]}|${MONTH_ABBR[i]})$`).test(t)) return i + 1;
  }
  return undefined;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
function ymd(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= daysIn(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const addDays = (day: string, n: number): string => msToDay(dayMs(day) + n * 86_400_000);
const weekday = (day: string): number => new Date(dayMs(day)).getUTCDay(); // 0 = Sunday
const diff = (a: string, b: string): number => Math.round((dayMs(b) - dayMs(a)) / 86_400_000);
const fullYear = (y: string | number | undefined): number | undefined => {
  if (y === undefined || y === "") return undefined;
  const n = typeof y === "number" ? y : parseInt(y, 10);
  return n < 100 ? 2000 + n : n;
};

interface Win { from: string; to: string }

/** A whole month, or the part of it still ahead of `today`. */
function monthWindow(month: number, year: number | undefined, today: string): Win {
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  const td = Number(today.slice(8, 10));
  let y = year;
  if (y === undefined) y = month < tm || (month === tm && td > 25) ? ty + 1 : ty;
  let from = `${y}-${pad(month)}-01`;
  const to = `${y}-${pad(month)}-${pad(daysIn(y, month))}`;
  if (from < today && to >= today) from = today;
  return { from, to };
}

/** The coming run of `len` months starting at `startMonth` (a season). */
function seasonWindow(startMonth: number, len: number, today: string): Win {
  const ty = Number(today.slice(0, 4));
  for (const y of [ty - 1, ty, ty + 1]) {
    const from = `${y}-${pad(startMonth)}-01`;
    const endM = startMonth + len - 1;
    const ey = y + Math.floor((endM - 1) / 12);
    const em = ((endM - 1) % 12) + 1;
    const to = `${ey}-${pad(em)}-${pad(daysIn(ey, em))}`;
    if (to >= today) return { from: from < today ? today : from, to };
  }
  return monthWindow(startMonth, undefined, today);
}

/** The next occurrence of day/month on or after `today`. */
function nextDate(month: number, day: number, year: number | undefined, today: string): string | null {
  if (year !== undefined) return ymd(year, month, day);
  const ty = Number(today.slice(0, 4));
  const here = ymd(ty, month, day);
  if (here && here >= today) return here;
  return ymd(ty + 1, month, day);
}

// --- the parser ---------------------------------------------------------------------------------

const UNITS_AFTER = String.raw`(?!\s*-?\s*(?:days?|nights?|weeks?|noches?|dias?|semanas?|adults?|adultos?|people|persons|personas|kids?|child|children|ночей|ночи|ночь|дн\p{L}*|недел\p{L}*|взросл\p{L}*|человек\p{L}*))`;

const CURRENCIES: [RegExp, string][] = [
  [re(String.raw`^(?:€|eur|euros?|евро)$`), "EUR"],
  [re(String.raw`^(?:\$|usd|dollars?|dolares|долл\p{L}*|бакс\p{L}*)$`), "USD"],
  [re(String.raw`^(?:£|gbp|pounds?|libras|фунт\p{L}*)$`), "GBP"],
];

function minorExponent(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function parseAmount(raw: string, k: string | undefined): number | undefined {
  let s = raw.trim();
  if (/^\d{1,3}([ ,.]\d{3})+$/.test(s)) s = s.replace(/[ ,.]/g, "");
  else s = s.replace(",", ".");
  let n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (k) n *= 1000;
  return n;
}

interface Hit { m: RegExpExecArray }

export function parsePlanText(text: string, today: string, profile: Profile, known: KnownPlace[] = []): ParsedPlan {
  const original = text.trim();
  const request: Partial<PlanRequest> = {};
  if (!original) return { request, confidence: 0, missing: ["window", "nights", "interests"] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("parsePlanText: today must be YYYY-MM-DD");

  let work = fold(original);
  /** Find the first match, blank it out so later rules do not read it again, return it. */
  const take = (r: RegExp): RegExpExecArray | null => {
    const m = r.exec(work);
    if (!m) return null;
    work = work.slice(0, m.index) + " ".repeat(m[0].length) + work.slice(m.index + m[0].length);
    return m;
  };
  const peek = (r: RegExp): RegExpExecArray | null => r.exec(work);

  let window: Win | undefined;
  let nights: { min: number; max: number } | undefined;
  let explicitRange = false;

  // --- origin
  const from = take(re(String.raw`${B}(?:from|desde|iz|departing from|leaving from|вылет(?:ая)? из|из|de)\s+(valencia|alicante|madrid|barcelona|girona|malaga|валенси\p{L}*|аликант\p{L}*|мадрид\p{L}*|барселон\p{L}*)${E}`));
  if (from) {
    const code = ORIGINS.find(([r]) => r.test(from[1]!))?.[1];
    if (code) request.origin = [code];
  }
  // "Madrid to Lisbon": the first city of a pair is the origin.
  if (!request.origin) {
    const pair = take(re(String.raw`${B}(valencia|alicante|madrid|barcelona|girona|malaga|валенси\p{L}*|аликант\p{L}*|мадрид\p{L}*|барселон\p{L}*)\s*(?:to|->|→|-|a(?=\s+(?!la\s|las\s|el\s|los\s|un\s|una\s|mi\s|mis\s|tu\s|que\s|casa\s|finales\s|principios\s|mediados\s)\p{L}))\s+(?=\p{L})`));
    if (pair) {
      const code = ORIGINS.find(([r]) => r.test(pair[1]!))?.[1];
      if (code) request.origin = [code];
    }
  }

  // --- known places (after the origin, so "from Barcelona to Lisbon" is Lisbon; before interests, so
  // "Mexico City" is not "city")
  const found = findDestination(work, known);
  if (found) {
    work = work.slice(0, found.index) + " ".repeat(found.length) + work.slice(found.index + found.length);
    request.destination = found.name;
  }

  // --- dates ---------------------------------------------------------------------------------
  // ISO range or day
  let m = take(re(String.raw`${B}(\d{4})-(\d{2})-(\d{2})\s*(?:-|to|until|till|through|\.\.|al|по|до)\s*(\d{4})-(\d{2})-(\d{2})${E}`));
  if (m) {
    const a = ymd(+m[1]!, +m[2]!, +m[3]!);
    const b = ymd(+m[4]!, +m[5]!, +m[6]!);
    if (a && b && b >= a) { window = { from: a, to: b }; explicitRange = b > a; }
  }
  if (!window && (m = take(re(String.raw`${B}(\d{4})-(\d{2})-(\d{2})${E}`)))) {
    const a = ymd(+m[1]!, +m[2]!, +m[3]!);
    if (a) window = { from: a, to: a };
  }
  // 5-9 December, from 28 Nov to 3 Dec, del 5 al 9 de diciembre, с 5 по 9 декабря
  if (!window && (m = take(re(String.raw`${B}(?:from|del|desde(?:\s+el)?|с|between|entre(?:\s+el)?)?\s*(\d{1,2})(?:st|nd|rd|th|o|º)?\s*(?:(?:de|of)\s+)?(?:(${MON_ANY})\.?\s*)?(?:-|to|until|till|through|thru|and|y|al|hasta(?:\s+el)?|по|до|и)\s*(\d{1,2})(?:st|nd|rd|th|o|º)?\s*(?:(?:de|of)\s+)?(${MON_ANY})\.?(?:\s*(?:de|del|of|,)?\s*(\d{4}))?${E}`)))) {
    const m2 = monthOf(m[4]!);
    const m1 = m[2] ? monthOf(m[2]) : m2;
    if (m1 && m2) {
      const a = nextDate(m1, +m[1]!, fullYear(m[5]), today);
      if (a) {
        const ay = Number(a.slice(0, 4));
        let b = ymd(m2 < m1 ? ay + 1 : ay, m2, +m[3]!);
        if (b && b < a) b = ymd(ay + 1, m2, +m[3]!);
        if (b && b >= a) { window = { from: a, to: b }; explicitRange = b > a; }
      }
    }
  }
  // December 5-9, Dec 28 to Jan 3
  if (!window && (m = take(re(String.raw`${B}(${MON_ANY})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|to|until|till|through|and|al|hasta|по|до)\s*(?:(${MON_ANY})\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?(?!\d)${UNITS_AFTER}`)))) {
    const m1 = monthOf(m[1]!);
    const m2 = m[3] ? monthOf(m[3]) : m1;
    if (m1 && m2) {
      const a = nextDate(m1, +m[2]!, undefined, today);
      if (a) {
        const ay = Number(a.slice(0, 4));
        let b = ymd(m2 < m1 ? ay + 1 : ay, m2, +m[4]!);
        if (b && b < a) b = ymd(ay + 1, m2, +m[4]!);
        if (b && b >= a) { window = { from: a, to: b }; explicitRange = b > a; }
      }
    }
  }
  // 5/12 - 9/12 (day first)
  if (!window && (m = take(re(String.raw`${B}(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*(?:-|to|until|al|a|по|до)\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?${E}`)))) {
    const a = nextDate(+m[2]!, +m[1]!, fullYear(m[3]), today);
    if (a) {
      const ay = Number(a.slice(0, 4));
      let b = ymd(fullYear(m[6]) ?? ay, +m[5]!, +m[4]!);
      if (b && b < a) b = ymd(ay + 1, +m[5]!, +m[4]!);
      if (b && b >= a) { window = { from: a, to: b }; explicitRange = b > a; }
    }
  }
  // 12 December, on the 12th of December, December 12
  if (!window && (m = take(re(String.raw`${B}(\d{1,2})(?:st|nd|rd|th|o|º)?\s*(?:(?:de|of)\s+)?(${MON_ANY})\.?(?:\s*(?:de|del|of|,)?\s*(\d{4}))?${E}`)))) {
    const mo = monthOf(m[2]!);
    const a = mo ? nextDate(mo, +m[1]!, fullYear(m[3]), today) : null;
    if (a) window = { from: a, to: a };
  }
  if (!window && (m = take(re(String.raw`${B}(${MON_ANY})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)${UNITS_AFTER}(?:\s*,?\s*(\d{4}))?`)))) {
    const mo = monthOf(m[1]!);
    const a = mo ? nextDate(mo, +m[2]!, fullYear(m[3]), today) : null;
    if (a) window = { from: a, to: a };
  }

  // weekends and relative periods. A weekend with a month ("a weekend in March") keeps the month.
  let weekend: { next: boolean; len: number } | undefined;
  const we = !window ? take(re(String.raw`${B}((?:next|following|proximo|siguiente|следующ\p{L}*|ближайш\p{L}*)\s+)?((?:long|largo|длинн\p{L}*)\s+)?(weekends?|week-end|fin de semana|finde|выходн\p{L}*|уикенд\p{L}*|puente)(\s+(?:largo|que viene|siguiente|proximo|long|next))?${E}`)) : null;
  if (we) {
    const tail = we[4] ?? "";
    const next = !!we[1] || /que viene|siguiente|proximo|next/.test(tail);
    const long = !!we[2] || /largo|long/.test(tail) || we[3] === "puente";
    weekend = { next, len: long ? 3 : 2 };
    nights = { min: weekend.len, max: weekend.len };
  }
  if (!window && take(re(String.raw`${B}(?:next week|la semana que viene|la proxima semana|proxima semana|на следующей неделе|на будущей неделе)${E}`))) {
    const dow = weekday(today);
    const mon = addDays(today, ((8 - dow) % 7) || 7);
    window = { from: mon, to: addDays(mon, 6) };
  }
  if (!window && take(re(String.raw`${B}(?:next month|el mes que viene|el proximo mes|proximo mes|в следующем месяце|в будущем месяце)${E}`))) {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    window = tm === 12 ? monthWindow(1, ty + 1, today) : monthWindow(tm + 1, ty, today);
  }
  if (!window && take(re(String.raw`${B}(?:this month|este mes|в этом месяце)${E}`))) {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    window = monthWindow(tm, ty, today);
  }

  // "in December", "mid-December 2027", "en diciembre", "в декабре"
  if (!window) {
    const mm = peek(re(String.raw`${B}(?:(early|mid|late|end of|beginning of|start of|principios de|comienzos de|mediados de|finales de|fines de|в начале|в середине|в конце)[\s-]+)?(?:(in|during|for|on|en|de|del|в|во|на|until|this|next|every|early|mid|late)\s+)?(${MON_FULL})(?:\s+(\d{4}))?${E}`));
    if (mm) {
      const mo = monthOf(mm[3]!);
      // "may" alone is the verb: it needs a preposition, a modifier or a year.
      const bareMay = mo === 5 && mm[3] === "may" && !mm[1] && !mm[2] && !mm[4];
      if (mo && !bareMay) {
        work = work.slice(0, mm.index) + " ".repeat(mm[0].length) + work.slice(mm.index + mm[0].length);
        let w = monthWindow(mo, fullYear(mm[4]), today);
        const part = (mm[1] ?? mm[2] ?? "").trim();
        const lastDay = Number(w.to.slice(8, 10));
        const monthStart = `${w.to.slice(0, 8)}01`;
        let from = w.from, to = w.to;
        if (/^(early|beginning of|start of|principios de|comienzos de|в начале)$/.test(part)) { from = monthStart; to = `${w.to.slice(0, 8)}${pad(Math.min(10, lastDay))}`; }
        else if (/^(mid|mediados de|в середине)$/.test(part)) { from = `${w.to.slice(0, 8)}10`; to = `${w.to.slice(0, 8)}${pad(Math.min(20, lastDay))}`; }
        else if (/^(late|end of|finales de|fines de|в конце)$/.test(part)) { from = `${w.to.slice(0, 8)}20`; to = w.to; }
        if (to >= today) w = { from: from < today ? today : from, to };
        window = w;
      }
    }
  }
  if (!window) {
    const s = take(re(String.raw`${B}(?:(?:in|during|this|next|en|durante)\s+)?(summer|winter|spring|autumn|fall|verano|invierno|primavera|otono|летом|лето|зимой|зиму|зима|весной|весна|осенью|осень)${E}`));
    if (s) {
      const w = s[1]!;
      if (/summer|verano|лет/.test(w)) window = seasonWindow(6, 3, today);
      else if (/winter|invierno|зим/.test(w)) window = seasonWindow(12, 3, today);
      else if (/spring|primavera|весн/.test(w)) window = seasonWindow(3, 3, today);
      else window = seasonWindow(9, 3, today);
    }
  }

  if (weekend && !window) {
    const friday = addDays(today, (5 - weekday(today) + 7) % 7);
    const fri = weekend.next ? addDays(friday, 7) : friday;
    window = { from: fri, to: addDays(fri, weekend.len) };
  }

  // --- length --------------------------------------------------------------------------------
  const setNights = (min: number, max: number) => {
    if (min >= 1 && max >= min && max <= 60) nights = { min, max };
  };
  let dur: RegExpExecArray | null;
  if ((dur = take(re(String.raw`${B}(\d{1,2})\s*(?:-|to|or|a|до|или)\s*(\d{1,2})\s*(?:-\s*)?(?:nights?|noches?|ноч(?:ей|и|ь))${E}`)))) {
    setNights(+dur[1]!, +dur[2]!);
  } else if ((dur = take(re(String.raw`${B}${NUM}\s*(?:-\s*)?(?:nights?|noches?|ноч(?:ей|и|ь))${E}`)))) {
    const n = toNum(dur[1]);
    if (n) setNights(n, n);
  } else if ((dur = take(re(String.raw`${B}(\d{1,2})\s*(?:-|to|or|a|до|или)\s*(\d{1,2})\s*(?:-\s*)?(?:days?|dias?|дн(?:ей|я|ь)|день|суток)${E}`)))) {
    setNights(Math.max(1, +dur[1]! - 1), +dur[2]!);
  } else if ((dur = take(re(String.raw`${B}${NUM}\s*(?:-\s*)?(?:days?|dias?|дн(?:ей|я|ь)|день|суток)${E}`)))) {
    const d = toNum(dur[1]);
    if (d && d >= 2) setNights(d - 1, d);
    else if (d === 1) setNights(1, 1);
  } else if ((dur = take(re(String.raw`${B}${NUM}\s*(?:-\s*)?(?:weeks?|semanas?|недел\p{L}*)${E}`)))) {
    const w = toNum(dur[1]);
    if (w) setNights(7 * w, 7 * w);
  } else if (take(re(String.raw`${B}(?:week[- ]?long|на неделю|una semanita)${E}`))) {
    setNights(7, 7);
  }

  // The window's own length when nothing else gave one.
  if (window && !nights && explicitRange) setNights(Math.max(1, diff(window.from, window.to)), Math.max(1, diff(window.from, window.to)));

  // --- budget --------------------------------------------------------------------------------
  const CUR = String.raw`(€|eur(?:os?)?|euros?|евро|\$|usd|dollars?|dolares|долл\p{L}*|бакс\p{L}*|£|gbp|pounds?|libras|фунт\p{L}*)`;
  const AMT = String.raw`(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|тыс\.?)?`;
  const CUE = String.raw`(?:under|below|less than|up to|upto|max(?:imum)?|at most|no more than|not more than|budget(?: of| is)?|hasta|menos de|por menos de|maximo|como maximo|presupuesto(?: de)?|не больше|не более|менее|бюджет(?: до| в)?|максимум|дешевле|до)`;
  let money: { amount: number; cur?: string } | undefined;
  const cueFirst = peek(re(String.raw`${B}${CUE}\s*(?:of\s*)?${CUR}?\s*${AMT}\s*${CUR}?${E}`));
  if (cueFirst) {
    const amount = parseAmount(cueFirst[2]!, cueFirst[3]);
    const cur = cueFirst[1] ?? cueFirst[4];
    // A bare number after a cue is a budget only when it looks like money.
    if (amount !== undefined && (cur || amount >= 100)) {
      money = { amount, cur };
      work = work.slice(0, cueFirst.index) + " ".repeat(cueFirst[0].length) + work.slice(cueFirst.index + cueFirst[0].length);
    }
  }
  if (!money) {
    const sym = take(re(String.raw`${CUR}\s*${AMT}${E}`)) ?? null;
    if (sym) {
      const amount = parseAmount(sym[2]!, sym[3]);
      if (amount !== undefined) money = { amount, cur: sym[1] };
    } else {
      const after = take(re(String.raw`${B}${AMT}\s*${CUR}${E}`));
      if (after) {
        const amount = parseAmount(after[1]!, after[2]);
        if (amount !== undefined) money = { amount, cur: after[3] };
      }
    }
  }
  if (money && money.amount > 0) {
    const currency = money.cur ? (CURRENCIES.find(([r]) => r.test(fold(money!.cur!)))?.[1] ?? profile.currency) : profile.currency;
    request.budget_total = { amount_minor: Math.round(money.amount * 10 ** minorExponent(currency)), currency };
  }

  // --- travellers ---------------------------------------------------------------------------
  let adults: number | undefined;
  let children: number | undefined;
  const kidWord = String.raw`(?:child(?:ren)?|kids?|toddlers?|babies|baby|infants?|ninos?|ninas?|hijos?|hijas?|bebes?|дет(?:ей|и|ям|ьми)|ребен\p{L}*|малыш\p{L}*)`;
  let t: RegExpExecArray | null;
  if ((t = take(re(String.raw`${B}${NUM}\s+${kidWord}${E}`)))) children = toNum(t[1]);
  else if ((t = take(re(String.raw`${B}(?:my|our|the|mi|mis|su|мо\p{L}+)?\s*(son|daughter|hijo|hija|сын|дочь|дочку|сына)${E}`)))) children = 1;
  else if ((t = take(re(String.raw`${B}(?:with|and|y|con|и|с)\s+(?:my |our |the |mis |nuestros |мо\p{L}+ )?(kids|children|toddlers|ninos|hijos|детьми|дети)${E}`)))) children = 2;
  else if ((t = take(re(String.raw`${B}(?:with|and|y|con|и|с)\s+(?:a |my |our |the |un |mi |мо\p{L}+ )?(kid|child|baby|toddler|nino|nina|bebe|ребенком|малышом)${E}`)))) children = 1;
  if ((t = take(re(String.raw`${B}${NUM_N}\s*(?:adults?|adultos?|adultas?|взросл\p{L}*|people|persons|personas|pax|человек\p{L}*)${E}`)))) adults = toNum(t[1]);
  else if ((t = take(re(String.raw`${B}(?:for|para|для|somos|we are|we're|нас)\s+${NUM_N}${E}${UNITS_AFTER}`)))) {
    const n = toNum(t[1]);
    if (n && n >= 1 && n <= 12) adults = n;
  } else if ((t = take(re(String.raw`${B}(?:вдвоем|втроем|вчетвером|вчетвером|вшестером)${E}`)))) {
    adults = /вдвоем/.test(t[0]) ? 2 : /втроем/.test(t[0]) ? 3 : /вчетвером/.test(t[0]) ? 4 : 6;
  } else if ((t = take(re(String.raw`${B}(?:with|w/|con|с)\s+(?:my |our |a |mi |mis |моей |моим |своей |своим |мо\p{L}+ )?(?:wife|husband|partner|girlfriend|boyfriend|fianc\p{L}*|spouse|friend|buddy|mate|bf|gf|mujer|esposa|esposo|marido|pareja|novia|novio|amigo|amiga|жен\p{L}*|муж\p{L}*|девушк\p{L}*|парн\p{L}*|друг\p{L}*|подруг\p{L}*|супруг\p{L}*|любим\p{L}*)${E}`)))) {
    adults = 2;
  } else if ((t = take(re(String.raw`${B}with\s+(\d{1,2}|two|three|four|five|six)\s+friends${E}`)))) {
    const n = toNum(t[1]);
    if (n) adults = n + 1;
  } else if (take(re(String.raw`${B}(?:couples?|honeymoon|romantic|en pareja|for two|para dos|для двоих)${E}`))) {
    adults = 2;
  } else if (
    take(re(String.raw`${B}(?:solo (?:trip|travel\p{L}*|holiday)|alone|by myself|on my own|just me|en solitario|в одиночку|соло|(?:travel(?:l)?ing|going|voy|viajo|viajar|ir|viaje)\s+(?:a )?(?:solo|sola)|(?:еду|поеду|полечу|лечу|поедем|хочу|буду)\s+(?:один|одна))${E}`))
  ) {
    adults = 1;
  }
  if (adults !== undefined || children !== undefined) {
    request.travellers = { adults: adults ?? Math.max(1, profile.travellers.adults), children: children ?? 0 };
  }

  // --- car -------------------------------------------------------------------------------------
  const wantsCar = !!peek(re(String.raw`${B}(?:rent(?:ing)? a car|rental car|car rental|car hire|hire a car|rent a car|alquil\p{L}* (?:un )?coche|coche de alquiler|alquiler de coche|аренд\p{L}* (?:авто|машин)\p{L}*|(?:взять|арендовать) машину|машин\p{L}* напрокат)${E}`));
  if (wantsCar) {
    take(re(String.raw`${B}(?:rent(?:ing)? a car|rental car|car rental|car hire|hire a car|alquil\p{L}* (?:un )?coche|coche de alquiler|alquiler de coche|аренд\p{L}* (?:авто|машин)\p{L}*|(?:взять|арендовать) машину|машин\p{L}* напрокат)${E}`));
    request.needs = ["flights", "stay", "car", "activities", "events"] as PlanRequest["needs"];
  }

  // --- interests ------------------------------------------------------------------------------
  const interests: Interest[] = [];
  for (const [interest, src] of INTEREST_WORDS) {
    if (interests.includes(interest)) continue;
    if (take(re(`${B}(?:${src})${E}`))) interests.push(interest);
  }
  if (interests.length) request.interests = interests.filter((i) => (INTERESTS as readonly string[]).includes(i));

  // --- assemble -------------------------------------------------------------------------------
  if (window) request.window = window;
  if (nights) request.nights = nights;
  request.text = original;

  const missing: string[] = [];
  if (!window) missing.push("window");
  if (!nights) missing.push("nights");
  if (!interests.length && !request.destination) missing.push("interests");

  let confidence = 0;
  if (window) confidence += 0.35;
  if (nights) confidence += 0.25;
  if (interests.length || request.destination) confidence += 0.2;
  if (request.budget_total) confidence += 0.1;
  if (request.travellers) confidence += 0.1;
  confidence = Math.round(Math.min(1, confidence) * 100) / 100;
  return { request, confidence, missing };
}

// --- origins, destinations, interests -------------------------------------------------------------

const ORIGINS: [RegExp, string][] = [
  [/^(valencia|валенси)/, "VLC"],
  [/^(alicante|аликант)/, "ALC"],
  [/^(madrid|мадрид)/, "MAD"],
  [/^(barcelona|барселон)/, "BCN"],
  [/^girona/, "GRO"],
  [/^malaga/, "AGP"],
];

/** Canonical place, then names in other languages. A trailing * allows Russian endings. */
const ALIASES: [string, string[]][] = [
  ["Lisbon", ["lisboa", "лиссабон*"]], ["Rome", ["roma", "рим[аеу]?", "римск*"]], ["London", ["londres", "лондон*"]], ["Paris", ["париж*"]],
  ["Milan", ["milano", "милан*"]], ["Venice", ["venecia", "венеци*"]], ["Florence", ["florencia", "флоренци*"]],
  ["Naples", ["napoles", "неапол*"]], ["Vienna", ["viena", "вен[аыуе]"]], ["Prague", ["praga", "праг[аеу]"]],
  ["Athens", ["atenas", "афин*"]], ["Istanbul", ["estambul", "стамбул*"]], ["Munich", ["munchen", "мюнхен*"]],
  ["Berlin", ["берлин*"]], ["Copenhagen", ["copenhague", "копенгаген*"]], ["Stockholm", ["estocolmo", "стокгольм*"]],
  ["Kraków", ["krakow", "cracovia", "краков*"]], ["Barcelona", ["барселон*"]], ["Madrid", ["мадрид*"]],
  ["Seville", ["sevilla", "севиль*"]], ["Granada", ["гранад*"]], ["Málaga", ["malaga", "малаг*"]],
  ["Palma de Mallorca", ["mallorca", "majorca", "palma", "майорк*", "мальорк*"]], ["Tenerife", ["тенерифе"]], ["Ibiza", ["ибиц*"]],
  ["Menorca", ["minorca", "менорк*"]], ["Lanzarote", ["лансароте"]], ["Fuerteventura", ["фуэртевентур*"]],
  ["Gran Canaria", ["gran canaria", "гран-канари*", "гран канари*"]], ["Bilbao", ["бильбао"]],
  ["San Sebastián", ["san sebastian", "donostia", "сан-себастьян*"]], ["Santiago de Compostela", ["сантьяго-де-компостел*"]],
  ["Porto", ["oporto", "порту"]], ["Madeira", ["мадейр*"]], ["São Miguel", ["azores", "azores", "азор*"]],
  ["Reykjavik", ["reikiavik", "рейкьявик*"]], ["Dubrovnik", ["дубровник*"]], ["Ljubljana", ["любляна", "любляну"]],
  ["Budapest", ["будапешт*"]], ["Amsterdam", ["amsterdam", "амстердам*"]], ["Dublin", ["dublin", "дублин*"]],
  ["Marrakech", ["marrakesh", "marrakech", "марракеш*"]], ["New York", ["nueva york", "new york", "нью-йорк*", "нью йорк*"]],
  ["Mexico City", ["mexico city", "ciudad de mexico", "мехико"]], ["Tokyo", ["tokio", "токио"]], ["Bali", ["бали"]],
  ["Santorini", ["санторини"]], ["Mykonos", ["миконос*"]], ["Chania", ["creta", "crete", "крит[аеуы]?"]],
  ["Cape Town", ["ciudad del cabo", "кейптаун*"]], ["Zanzibar", ["занзибар*"]], ["Tromsø", ["tromso", "тромсе"]],
  ["Chamonix", ["шамони"]], ["Zermatt", ["церматт*"]], ["Andorra", ["андорр*"]], ["Faro", ["фару"]], ["Valletta", ["malta", "мальт*"]],
  ["Tarifa", ["тариф[аеу]"]], ["Dahab", ["дахаб*"]], ["Palermo", ["sicilia", "sicily", "палермо", "сицили*"]],
  ["Cagliari", ["cerdena", "sardinia", "sardegna", "сардини*"]], ["Kotor", ["котор*"]], ["Tirana", ["тиран[аеу]"]],
  ["Bordeaux", ["бордо"]], ["Lyon", ["лион*"]], ["Biarritz", ["биарриц*"]], ["Bologna", ["болонь*"]],
  ["Sierra Nevada", ["сьерра-невад*", "сьерра невад*"]], ["Val Thorens", ["валь-торанс*"]],
  ["St Anton am Arlberg", ["st anton", "st. anton", "sankt anton", "санкт-антон*"]],
  ["Cortina d'Ampezzo", ["cortina", "кортина*"]], ["Courmayeur", ["куршевел*", "курмайор*"]],
];
/** Names a sentence uses for other things ("a nice weekend", "split the cost"). */
const AMBIGUOUS: Record<string, RegExp> = {
  nice: re(String.raw`^,?\s*(france|francia|франци\p{L}*)`),
  split: re(String.raw`^,?\s*(croatia|croacia|хорвати\p{L}*)`),
};
const COUNTRY_ALIASES: [string, string[]][] = [
  ["Portugal", ["португали*"]], ["Italy", ["italia", "итали*"]], ["France", ["francia", "франци*"]], ["Greece", ["grecia", "греци*"]],
  ["Croatia", ["croacia", "хорвати*"]], ["Morocco", ["marruecos", "марокко"]], ["Iceland", ["islandia", "исланди*"]],
  ["Germany", ["alemania", "герман*"]], ["Austria", ["австри*"]], ["Switzerland", ["suiza", "швейцари*"]],
  ["United Kingdom", ["uk", "great britain", "reino unido", "inglaterra", "england", "англи*", "великобритани*"]],
  ["Spain", ["espana", "испани*"]], ["Netherlands", ["holland", "paises bajos", "holanda", "голланди*", "нидерланд*"]],
  ["Japan", ["japon", "япони*"]], ["Czechia", ["czech republic", "chequia", "чехи*"]], ["Poland", ["polonia", "польш*"]],
  ["Hungary", ["hungria", "венгри*"]], ["Türkiye", ["turkey", "turquia", "турци*"]], ["Egypt", ["egipto", "египет*"]],
  ["Mexico", ["mexico", "мексик*"]], ["United States", ["usa", "estados unidos", "eeuu", "сша", "америк*"]],
];

/** A term is a regex fragment: spaces match a space or hyphen, a trailing * allows Russian endings. */
function nameRegex(term: string): string {
  const stem = term.endsWith("*");
  const body = term.replace(/\*$/, "").replace(/ /g, "[\\s-]+");
  return stem ? `${body}\\p{L}*` : body;
}

const foldTerm = (t: string): string => fold(t.replace(/\*$/, "")) + (t.endsWith("*") ? "*" : "");

/** The earliest known place in the text (the longer name on a tie); countries only when no place is named. */
function findDestination(work: string, known: KnownPlace[]): { name: string; index: number; length: number } | null {
  const search = (terms: { term: string; name: string }[], ambiguous: boolean) => {
    let best: { name: string; index: number; length: number } | null = null;
    for (const { term, name } of terms) {
      const m = re(`${B}${nameRegex(term)}${E}`).exec(work);
      if (!m) continue;
      const amb = ambiguous ? AMBIGUOUS[term] : undefined;
      if (amb && !amb.test(work.slice(m.index + m[0].length, m.index + m[0].length + 24))) continue;
      if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) {
        best = { name, index: m.index, length: m[0].length };
      }
    }
    return best;
  };

  const places = new Map(known.map((k) => [fold(k.place), k.place]));
  const countries = new Map(known.map((k) => [fold(k.country), k.country]));
  const placeTerms: { term: string; name: string }[] = [];
  for (const [folded, name] of places) placeTerms.push({ term: folded, name });
  for (const [name, aliases] of ALIASES) for (const a of aliases) placeTerms.push({ term: foldTerm(a), name: places.get(fold(name)) ?? name });
  const place = search(placeTerms, true);
  if (place) return place;

  const countryTerms: { term: string; name: string }[] = [];
  for (const [folded, name] of countries) countryTerms.push({ term: folded, name });
  for (const [name, aliases] of COUNTRY_ALIASES) for (const a of aliases) countryTerms.push({ term: foldTerm(a), name: countries.get(fold(name)) ?? name });
  return search(countryTerms, false);
}

/** Words per interest. Order matters: the first rule to match a phrase takes it. */
const INTEREST_WORDS: [Interest, string][] = [
  ["kitesurf", String.raw`kite[- ]?surf\p{L}*|kite[- ]?board\p{L}*|kiting|kites?|кайт\p{L}*`],
  ["bikepacking", String.raw`bike[- ]?packing|bikepack\p{L}*|велопоход\p{L}*|бикпэкинг\p{L}*|bike[- ]?touring`],
  ["surf", String.raw`surf\p{L}*|windsurf\p{L}*|серф\p{L}*`],
  ["ski", String.raw`ski(?:ing)?|skis|snowboard\p{L}*|esqui\p{L}*|горнолыж\p{L}*|лыж\p{L}*|сноуборд\p{L}*`],
  ["triathlon", String.raw`triathl\p{L}*|triatl\p{L}*|ironman|триатлон\p{L}*|айронмен\p{L}*`],
  ["running", String.raw`running|marathon\p{L}*|maraton\p{L}*|half[- ]marathon|бег\p{L}*|марафон\p{L}*`],
  ["cycling", String.raw`cycl(?:e|ing|ist)\p{L}*|bikes?|biking|bicycle\p{L}*|ciclismo|bicis?|bicicleta\p{L}*|велосипед\p{L}*|велоспорт\p{L}*|вело`],
  ["padel", String.raw`padel|paddle tennis|падел\p{L}*|паддл\p{L}*`],
  ["volleyball", String.raw`volleyball|voleibol|voley|волейбол\p{L}*`],
  ["dive", String.raw`diving|scuba|snorkel\p{L}*|buce[oa]\p{L}*|дайвинг\p{L}*|дайв\p{L}*|погружен\p{L}*|снорк\p{L}*`],
  ["hiking", String.raw`hik(?:e|es|ing)|trek(?:king)?|senderismo|caminatas?|поход\p{L}*|хайкинг\p{L}*|треккинг\p{L}*|трекинг\p{L}*`],
  ["mountains", String.raw`mountains?|montan\p{L}*|горы|горах|горн\p{L}*|alps|alpes|pyrenees|pirineos|альп\p{L}*`],
  ["wine", String.raw`wines?|vino\p{L}*|winery|wineries|bodegas?|винн\p{L}*|вино|винодельн\p{L}*`],
  ["coffee", String.raw`coffee|cafes?|кофе\p{L}*|кофейн\p{L}*`],
  ["food", String.raw`food(?:ie|ies)?|gastronom\p{L}*|restaurants?|restaurantes?|comida|tapas|cuisine|еда|еды|гастро\p{L}*|ресторан\p{L}*|кухн\p{L}*`],
  ["nightlife", String.raw`nightlife|clubbing|night ?clubs?|clubs?|discotecas?|ocio nocturno|vida nocturna|ночн\p{L}*\s+жизн\p{L}*|клуб\p{L}*|тусов\p{L}*|party|parties`],
  ["festivals", String.raw`festivals?|festivales?|фестивал\p{L}*`],
  ["concerts", String.raw`concerts?|conciertos?|gigs?|live music|концерт\p{L}*`],
  ["sport-events", String.raw`football match|soccer match|sporting event|sports? events?|grand prix|gran premio|f1|гран-при|матч\p{L}*`],
  ["museums", String.raw`museums?|museos?|galleries|музе\p{L}*|галере\p{L}*`],
  ["culture", String.raw`culture|cultural|cultura|history|historic\p{L}*|historia|architecture|arquitectura|sightseeing|monuments?|культур\p{L}*|истори\p{L}*|архитектур\p{L}*`],
  ["wellness", String.raw`wellness|spas?|relax\p{L}*|yoga|retreat|detox|hot springs|termas|термальн\p{L}*|спа|йога|ретрит\p{L}*|расслаб\p{L}*|descans\p{L}*`],
  ["road-trip", String.raw`road[- ]?trips?|roadtrip|by car|en coche|на машине|на авто\p{L}*|автопутешеств\p{L}*`],
  ["family", String.raw`family (?:trip|holiday|vacation)|en familia|семейн\p{L}*|с детьми|kids friendly|child[- ]friendly`],
  ["nature", String.raw`nature|naturaleza|national parks?|parque nacional|waterfalls?|lakes?|lagos?|природ\p{L}*|заповедн\p{L}*|озер\p{L}*`],
  ["beach", String.raw`beach(?:es)?|playas?|пляж\p{L}*|seaside|coast|costa|islands?|isla|острова?|море|морю|морем|sea|warm|sunny|sunshine|sun|sol|soleado|calor|calido|тепл\p{L}*|солн\p{L}*|жарк\p{L}*|жара|tropical`],
  ["city", String.raw`city[- ]?breaks?|city|cities|urban|urbano|ciudad(?:es)?|город\p{L}*|сити[- ]?брейк\p{L}*`],
];
