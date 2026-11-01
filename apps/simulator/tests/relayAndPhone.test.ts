import { describe, expect, it } from "vitest";
import { Relay } from "../relay/relay";
import { coordsToGpsMessage, describeGeoError } from "../src/phone/gpsReporter";

const sock = () => {
  const sent: string[] = [];
  return { sent, send: (d: string) => void sent.push(d) };
};

describe("Relay", () => {
  it("forwards phone messages to displays only and reports presence", () => {
    const relay = new Relay();
    const display = sock();
    const phone = sock();
    relay.addClient(display, "display");
    expect(JSON.parse(display.sent[0]!)).toEqual({ type: "presence", phones: 0 });
    const remove = relay.addClient(phone, "phone");
    expect(JSON.parse(display.sent[1]!)).toEqual({ type: "presence", phones: 1 });
    relay.onMessage("phone", "hello");
    expect(display.sent[2]).toBe("hello");
    expect(phone.sent).toEqual([]); // phones never receive
    relay.onMessage("display", "ignored");
    expect(display.sent).toHaveLength(3);
    remove();
    expect(JSON.parse(display.sent.at(-1)!)).toEqual({ type: "presence", phones: 0 });
    expect(relay.phoneCount).toBe(0);
  });

  it("a failing display does not block others", () => {
    const relay = new Relay();
    const good = sock();
    relay.addClient({ send: () => { throw new Error("dead"); } }, "display");
    relay.addClient(good, "display");
    relay.onMessage("phone", "x");
    expect(good.sent.at(-1)).toBe("x");
  });
});

describe("coordsToGpsMessage", () => {
  const base = { latitude: 1, longitude: 2, speed: 10, heading: 45, accuracy: 5 };
  it("maps real values", () => {
    expect(coordsToGpsMessage(base)).toEqual({ type: "gps", latitude: 1, longitude: 2, speedMps: 10, headingDegrees: 45, accuracyMeters: 5 });
  });
  it("turns platform 'unknown' values into null (never 0)", () => {
    expect(coordsToGpsMessage({ ...base, speed: null }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: -1 }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: NaN }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: -1 }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: 0 }).speedMps).toBe(0);
  });
});

describe("describeGeoError", () => {
  it("explains permission denial", () => {
    expect(describeGeoError(1)).toMatch(/permission denied/i);
    expect(describeGeoError(2)).toMatch(/unavailable/i);
    expect(describeGeoError(3)).toMatch(/timed out/i);
    expect(describeGeoError(99)).toMatch(/unknown/i);
  });
});
