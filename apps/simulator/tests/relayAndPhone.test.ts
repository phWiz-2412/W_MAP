import { describe, expect, it } from "vitest";
import { Relay } from "../relay/relay";
import { coordsToGpsMessage, deriveSpeedAndHeadingFromSamples, describeGeoError } from "../src/phone/gpsReporter";

const sock = () => {
  const sent: string[] = [];
  return { sent, send: (d: string) => void sent.push(d) };
};

describe("Relay", () => {
  it("forwards phone messages to displays only, stamps relayReceivedAtMs, and echoes display pings", () => {
    let now = 5000;
    const relay = new Relay({ clock: () => now });
    const display = sock();
    const phone = sock();
    relay.addClient(display, "display");
    expect(JSON.parse(display.sent[0]!)).toEqual({ type: "presence", phones: 0 });
    const remove = relay.addClient(phone, "phone");
    expect(JSON.parse(display.sent[1]!)).toEqual({ type: "presence", phones: 1 });

    now = 5123;
    relay.onMessage("phone", JSON.stringify({ type: "gps", latitude: 21, longitude: 105 }));
    expect(JSON.parse(display.sent[2]!)).toEqual({
      type: "gps",
      latitude: 21,
      longitude: 105,
      relayReceivedAtMs: 5123,
    });
    expect(phone.sent).toEqual([]); // phones never receive

    // Display RTT ping is echoed back as pong
    now = 5200;
    relay.onMessage("display", JSON.stringify({ type: "ping", sentAtMs: 5190 }), display);
    expect(JSON.parse(display.sent[3]!)).toEqual({
      type: "pong",
      sentAtMs: 5190,
      relayAtMs: 5200,
    });

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

describe("coordsToGpsMessage & Haversine speed fallback", () => {
  const base = { latitude: 21.0285, longitude: 105.8542, speed: 10, heading: 45, accuracy: 5 };
  it("maps native speed and heading when provided", () => {
    expect(coordsToGpsMessage(base)).toEqual({
      type: "gps",
      latitude: 21.0285,
      longitude: 105.8542,
      speedMps: 10,
      headingDegrees: 45,
      accuracyMeters: 5,
    });
  });

  it("turns platform 'unknown' values into null (never 0) when no previous sample exists", () => {
    expect(coordsToGpsMessage({ ...base, speed: null }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: -1 }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: NaN }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: -1 }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: 0 }).speedMps).toBe(0);
  });

  it("derives speed and heading from consecutive samples when iOS Safari reports speed === null", () => {
    const prev = {
      coords: { latitude: 21.0285, longitude: 105.8542, speed: null, heading: null, accuracy: 5 },
      timestamp: 1000,
    };
    // ~11.1 meters north in 1000 ms => ~11.1 m/s (~40 km/h), heading ~0 deg
    const currCoords = { latitude: 21.0286, longitude: 105.8542, speed: null, heading: null, accuracy: 5 };
    const msg = coordsToGpsMessage(currCoords, {
      sampleTimestampMs: 2000,
      phoneReceivedAtMs: 2005,
      phoneSentAtMs: 2006,
      phoneSessionId: "s-1",
      phoneSeq: 2,
      previousSample: prev,
    });
    expect(msg.speedSource).toBe("derived");
    expect(msg.speedMps).toBeGreaterThan(10);
    expect(msg.speedMps).toBeLessThan(12);
    expect(msg.headingDegrees).toBeCloseTo(0, 0);
  });

  it("suppresses GPS jitter below noise floor and rejects poor accuracy in derived speed", () => {
    const prev = {
      coords: { latitude: 21.0285, longitude: 105.8542, speed: null, heading: null, accuracy: 8 },
      timestamp: 1000,
    };
    // Sub-meter jitter -> reports 0 m/s
    const jitter = deriveSpeedAndHeadingFromSamples(prev, {
      coords: { ...prev.coords, latitude: 21.028502 },
      timestamp: 2000,
    });
    expect(jitter.speedMps).toBe(0);

    // Poor accuracy (80m) -> returns null
    const poor = deriveSpeedAndHeadingFromSamples(
      { ...prev, coords: { ...prev.coords, accuracy: 80 } },
      { coords: { ...prev.coords, latitude: 21.029, accuracy: 80 }, timestamp: 2000 },
    );
    expect(poor.speedMps).toBeNull();
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
