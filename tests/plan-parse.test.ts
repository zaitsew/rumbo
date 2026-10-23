import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { fold, parsePlanText, type KnownPlace } from "../src/core/parse";
import { PlanRequestSchema, ProfileSchema } from "../src/core/schema";

// 2026-10-23 is a Friday.
const TODAY = "2026-10-23";
const profile = ProfileSchema.parse({ home_city: "Valencia", home_airports: ["VLC"], currency: "EUR", travellers: { adults: 2 } });

const DIR = join(__dirname, "..", "data", "destinations");
const known: KnownPlace[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join(DIR, f), "utf8")) as KnownPlace)
  .map((d) => ({ place: d.place, country: d.country }));

const p = (text: string, today = TODAY) => parsePlanText(text, today, profile, known);

interface Case {
  text: string;
  /** Subset of the parsed request. */
  expect: Record<string, unknown>;
}

const CASES: Case[] = [
  // --- English
  {
    text: "4 days of kitesurf in March, under €600, with my wife",
    expect: {
      window: { from: "2027-03-01", to: "2027-03-31" },
      nights: { min: 3, max: 4 },
      interests: ["kitesurf"],
      budget_total: { amount_minor: 60000, currency: "EUR" },
      travellers: { adults: 2, children: 0 },
    },
  },
  { text: "next weekend in Lisbon", expect: { destination: "Lisbon", window: { from: "2026-10-30", to: "2026-11-01" }, nights: { min: 2, max: 2 } } },
  { text: "this weekend", expect: { window: { from: "2026-10-23", to: "2026-10-25" }, nights: { min: 2, max: 2 } } },
  { text: "this long weekend", expect: { window: { from: "2026-10-23", to: "2026-10-26" }, nights: { min: 3, max: 3 } } },
  { text: "5-9 December in Rome", expect: { destination: "Rome", window: { from: "2026-12-05", to: "2026-12-09" }, nights: { min: 4, max: 4 } } },
  { text: "from 28 Nov to 3 Dec in Prague", expect: { destination: "Prague", window: { from: "2026-11-28", to: "2026-12-03" }, nights: { min: 5, max: 5 } } },
  { text: "Dec 28 to Jan 3 ski trip with 2 kids and my wife", expect: { window: { from: "2026-12-28", to: "2027-01-03" }, interests: ["ski"], travellers: { adults: 2, children: 2 } } },
  { text: "2026-12-05 to 2026-12-09, 3 adults", expect: { window: { from: "2026-12-05", to: "2026-12-09" }, travellers: { adults: 3, children: 0 } } },
  { text: "a week in Madeira in July", expect: { destination: "Madeira", window: { from: "2027-07-01", to: "2027-07-31" }, nights: { min: 7, max: 7 } } },
  { text: "2 adults 1 child, beach, 10 days in August", expect: { travellers: { adults: 2, children: 1 }, interests: ["beach"], nights: { min: 9, max: 10 }, window: { from: "2027-08-01", to: "2027-08-31" } } },
  { text: "somewhere warm in December for 5 nights", expect: { interests: ["beach"], window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 5, max: 5 } } },
  { text: "early January surf trip, rent a car, up to 800 eur", expect: { interests: ["surf"], window: { from: "2027-01-01", to: "2027-01-10" }, budget_total: { amount_minor: 80000, currency: "EUR" }, needs: ["flights", "stay", "car", "activities", "events"] } },
  { text: "mid-December city break in Vienna, wine and food, below 700 EUR", expect: { destination: "Vienna", interests: ["wine", "food", "city"], window: { from: "2026-12-10", to: "2026-12-20" }, budget_total: { amount_minor: 70000, currency: "EUR" } } },
  { text: "kitesurf in Tarifa next month for 3-4 nights", expect: { destination: "Tarifa", interests: ["kitesurf"], window: { from: "2026-11-01", to: "2026-11-30" }, nights: { min: 3, max: 4 } } },
  { text: "bikepacking and hiking in Sierra Nevada, 4 days in May", expect: { destination: "Sierra Nevada", interests: ["bikepacking", "hiking"], window: { from: "2027-05-01", to: "2027-05-31" }, nights: { min: 3, max: 4 } } },
  { text: "Madrid to Lisbon, 2 weeks, with 2 friends", expect: { origin: ["MAD"], destination: "Lisbon", nights: { min: 14, max: 14 }, travellers: { adults: 3, children: 0 } } },
  { text: "padel and sun in January, budget 900", expect: { interests: ["padel", "beach"], window: { from: "2027-01-01", to: "2027-01-31" }, budget_total: { amount_minor: 90000, currency: "EUR" } } },
  { text: "a weekend in Paris in March", expect: { destination: "Paris", window: { from: "2027-03-01", to: "2027-03-31" }, nights: { min: 2, max: 2 } } },
  { text: "solo trip next week", expect: { travellers: { adults: 1, children: 0 }, window: { from: "2026-10-26", to: "2026-11-01" } } },
  { text: "Mexico City in late November for 10 nights", expect: { destination: "Mexico City", window: { from: "2026-11-20", to: "2026-11-30" }, nights: { min: 10, max: 10 } } },
  { text: "$1,200 budget, Tokyo, 12 December 2026", expect: { destination: "Tokyo", window: { from: "2026-12-12", to: "2026-12-12" }, budget_total: { amount_minor: 120000, currency: "USD" } } },
  // --- Spanish
  {
    text: "Quiero ir a Lisboa en diciembre 4 noches con mi mujer, máximo 500 euros",
    expect: { destination: "Lisbon", window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 4, max: 4 }, travellers: { adults: 2, children: 0 }, budget_total: { amount_minor: 50000, currency: "EUR" } },
  },
  { text: "Un fin de semana en Roma con mi pareja", expect: { destination: "Rome", window: { from: "2026-10-23", to: "2026-10-25" }, travellers: { adults: 2, children: 0 } } },
  { text: "del 5 al 9 de diciembre en París, 2 adultos y 1 niño", expect: { destination: "Paris", window: { from: "2026-12-05", to: "2026-12-09" }, travellers: { adults: 2, children: 1 } } },
  { text: "una semana de playa en verano, para dos, presupuesto 1.200 euros", expect: { interests: ["beach"], window: { from: "2027-06-01", to: "2027-08-31" }, nights: { min: 7, max: 7 }, travellers: { adults: 2, children: 0 }, budget_total: { amount_minor: 120000, currency: "EUR" } } },
  { text: "vuelo Barcelona a Roma el 12 de noviembre, 3 noches", expect: { origin: ["BCN"], destination: "Rome", window: { from: "2026-11-12", to: "2026-11-12" }, nights: { min: 3, max: 3 } } },
  { text: "a finales de enero, esquí en los Pirineos, 5 días", expect: { interests: ["ski", "mountains"], window: { from: "2027-01-20", to: "2027-01-31" }, nights: { min: 4, max: 5 } } },
  // --- Russian
  {
    text: "Хочу в Лиссабон в декабре на 5 дней с женой, бюджет до 600 евро",
    expect: { destination: "Lisbon", window: { from: "2026-12-01", to: "2026-12-31" }, nights: { min: 4, max: 5 }, travellers: { adults: 2, children: 0 }, budget_total: { amount_minor: 60000, currency: "EUR" } },
  },
  { text: "на длинные выходные в Прагу", expect: { destination: "Prague", window: { from: "2026-10-23", to: "2026-10-26" }, nights: { min: 3, max: 3 } } },
  { text: "в следующие выходные на море", expect: { interests: ["beach"], window: { from: "2026-10-30", to: "2026-11-01" } } },
  { text: "с 5 по 9 декабря в Рим", expect: { destination: "Rome", window: { from: "2026-12-05", to: "2026-12-09" }, nights: { min: 4, max: 4 } } },
  { text: "Поеду один на неделю в горы кататься на лыжах в феврале", expect: { travellers: { adults: 1, children: 0 }, interests: ["ski", "mountains"], window: { from: "2027-02-01", to: "2027-02-28" }, nights: { min: 7, max: 7 } } },
  { text: "с 28 ноября по 3 декабря в Стамбул вдвоем", expect: { destination: "Istanbul", window: { from: "2026-11-28", to: "2026-12-03" }, travellers: { adults: 2, children: 0 } } },
  { text: "в начале января кайтсерфинг, аренда авто, до 800 евро", expect: { interests: ["kitesurf"], window: { from: "2027-01-01", to: "2027-01-10" }, budget_total: { amount_minor: 80000, currency: "EUR" }, needs: ["flights", "stay", "car", "activities", "events"] } },
  { text: "кофе и вино в мае, 3 ночи", expect: { interests: ["wine", "coffee"], window: { from: "2027-05-01", to: "2027-05-31" }, nights: { min: 3, max: 3 } } },
];

describe("parsePlanText: English, Spanish and Russian phrasings", () => {
  for (const c of CASES) {
    it(c.text, () => {
      const r = p(c.text);
      expect(r.request).toMatchObject(c.expect);
    });
  }

  it("has more than twenty phrasings in all three languages", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(CASES.some((c) => /[а-я]/i.test(c.text))).toBe(true);
    expect(CASES.some((c) => /\b(quiero|fin de semana|noches)\b/i.test(c.text))).toBe(true);
  });
});

describe("parsePlanText: what it leaves out", () => {
  it("returns an empty request and zero confidence for nothing", () => {
    expect(p("")).toEqual({ request: {}, confidence: 0, missing: ["window", "nights", "interests"] });
    const r = p("I may go somewhere");
    expect(r.request).toEqual({ text: "I may go somewhere" });
    expect(r.confidence).toBe(0);
  });

  it("keeps the person's own words in `text`", () => {
    expect(p("  a week in Madeira in July ").request.text).toBe("a week in Madeira in July");
  });

  it("does not read nights, adults or dates as a budget", () => {
    const r = p("3 nights, 2 adults, up to 5 kids, 12 December");
    expect(r.request.budget_total).toBeUndefined();
    expect(r.request.window).toEqual({ from: "2026-12-12", to: "2026-12-12" });
    expect(r.request.nights).toEqual({ min: 3, max: 3 });
  });

  it("reads 'may' as a month only with a preposition, a modifier or a year", () => {
    expect(p("I may go to Lisbon").request.window).toBeUndefined();
    expect(p("in May in Lisbon").request.window).toEqual({ from: "2027-05-01", to: "2027-05-31" });
    expect(p("5 May 2028").request.window).toEqual({ from: "2028-05-05", to: "2028-05-05" });
  });

  it("is not fooled by place names that are common words", () => {
    expect(p("a nice weekend somewhere").request.destination).toBeUndefined();
    expect(p("let's split the cost").request.destination).toBeUndefined();
    expect(p("3 nights in Nice, France").request.destination).toBe("Nice");
  });

  it("does not take 'Mexico City' for a city break", () => {
    const r = p("Mexico City in late November");
    expect(r.request.destination).toBe("Mexico City");
    expect(r.request.interests).toBeUndefined();
  });

  it("names a country as the destination when no place is named", () => {
    expect(p("a week in Portugal in June").request.destination).toBe("Portugal");
    expect(p("una semana en Italia en junio").request.destination).toBe("Italy");
  });

  it("uses the profile currency when the amount has none", () => {
    const usd = ProfileSchema.parse({ home_city: "NYC", home_airports: ["JFK"], currency: "USD" });
    expect(parsePlanText("budget 900, 5 nights in June", TODAY, usd, known).request.budget_total).toEqual({ amount_minor: 90000, currency: "USD" });
  });

  it("gives a plain adult count when children are named without adults", () => {
    expect(p("with 2 kids in July").request.travellers).toEqual({ adults: 2, children: 2 });
  });
});

describe("parsePlanText: dates", () => {
  it("rolls a month already past to next year, and the current month runs from today", () => {
    expect(p("in September").request.window).toEqual({ from: "2027-09-01", to: "2027-09-30" });
    expect(p("in October", "2026-10-10").request.window).toEqual({ from: "2026-10-10", to: "2026-10-31" });
    expect(p("in October", "2026-10-28").request.window).toEqual({ from: "2027-10-01", to: "2027-10-31" });
  });

  it("puts a weekend that is nearly over on the next one", () => {
    // Saturday 2026-10-24 and Sunday 2026-10-25.
    expect(p("this weekend", "2026-10-24").request.window).toEqual({ from: "2026-10-30", to: "2026-11-01" });
    expect(p("this weekend", "2026-10-25").request.window).toEqual({ from: "2026-10-30", to: "2026-11-01" });
    expect(p("next weekend", "2026-10-26").request.window).toEqual({ from: "2026-11-06", to: "2026-11-08" });
  });

  it("crosses the year in a range and rolls a past day-month forward", () => {
    expect(p("30 December to 2 January").request.window).toEqual({ from: "2026-12-30", to: "2027-01-02" });
    expect(p("5 March").request.window).toEqual({ from: "2027-03-05", to: "2027-03-05" });
    expect(p("5/12 - 9/12").request.window).toEqual({ from: "2026-12-05", to: "2026-12-09" });
  });

  it("lets a stated length beat the length of the window", () => {
    expect(p("5-9 December, 3 nights").request.nights).toEqual({ min: 3, max: 3 });
  });

  it("rejects a malformed `today`", () => {
    expect(() => parsePlanText("x", "tomorrow", profile)).toThrow();
  });
});

describe("parsePlanText: confidence and missing", () => {
  it("is 1 for a full sentence and lists nothing missing", () => {
    const r = p("4 days of kitesurf in March, under €600, with my wife");
    expect(r.confidence).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("is under 0.7 when the length or the date is not said, and says what is missing", () => {
    const r = p("somewhere with good coffee in April");
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.missing).toEqual(["nights"]);
    const none = p("surprise me");
    expect(none.missing).toEqual(["window", "nights", "interests"]);
  });

  it("is at least 0.7 for a destination, a date and a length", () => {
    expect(p("5-9 December in Rome").confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("produces a request that the schema accepts once the defaults are added", () => {
    const r = p("4 days of kitesurf in March, under €600, with my wife");
    const full = PlanRequestSchema.safeParse({ window: { from: "2027-03-01", to: "2027-03-31" }, nights: { min: 3, max: 4 }, ...r.request });
    expect(full.success).toBe(true);
  });
});

describe("fold", () => {
  it("strips Latin accents but keeps Cyrillic letters", () => {
    expect(fold("Málaga Kraków São Tromsø Ñandú")).toBe("malaga krakow sao tromso nandu");
    expect(fold("Май, Йога, ёлка")).toBe("май, йога, елка");
  });
});
