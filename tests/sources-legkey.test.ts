import { describe, expect, it } from "vitest";
import { flightId, flightNo, legKey } from "../src/server/sources/id";

describe("leg keys", () => {
  const leg = { carrier: "TP", number: "1097", from: "VLC", to: "LIS", departLocal: "2026-12-06T07:30" };

  it("separates the same flight number and day at another time or between other airports", () => {
    expect(legKey(leg)).not.toBe(legKey({ ...leg, departLocal: "2026-12-06T18:10" }));
    expect(legKey(leg)).not.toBe(legKey({ ...leg, to: "OPO" }));
    const a = flightId({ origin: "VLC", destination: "FNC", depart_date: "2026-12-06", legs: [legKey(leg), legKey({ ...leg, number: "1700", from: "LIS", to: "FNC", departLocal: "2026-12-06T10:00" })] });
    const b = flightId({ origin: "VLC", destination: "FNC", depart_date: "2026-12-06", legs: [legKey(leg), legKey({ ...leg, number: "1700", from: "LIS", to: "FNC", departLocal: "2026-12-06T14:00" })] });
    expect(a).not.toBe(b);
  });

  it("matches a full airline name and an IATA code for the same designated flight", () => {
    expect(flightNo("TAP Air Portugal", "TP1097")).toBe("TP1097");
    expect(flightNo("TP", "1097")).toBe("TP1097");
    expect(legKey({ ...leg, carrier: "TAP Air Portugal", number: "TP1097" })).toBe(legKey(leg));
  });
});
