import { describe, expect, it } from "vitest";
import {
  MAX_ROUTE_POINTS,
  PROTOCOL_VERSION,
  TURN_DIRECTIONS,
  isNewerSequence,
  parseNavigationPacketJson,
  validateNavigationData,
  validateNavigationPacket,
  type NavigationData,
} from "../src";

const valid: NavigationData = {
  sequenceNumber: 1,
  timestamp: 1000,
  currentSpeedKmh: 45,
  speedLimitKmh: 50,
  turnDirection: "LEFT",
  distanceToTurnMeters: 300,
  latitude: 21,
  longitude: 105,
  headingDegrees: 90,
  gpsStatus: "ACTIVE",
  bleStatus: "CONNECTED",
  routeStatus: "ACTIVE",
  speedLimitStatus: "VALID",
  routePoints: [
    { latitude: 21, longitude: 105 },
    { latitude: 21.001, longitude: 105 },
  ],
};
const bad = (patch: Record<string, unknown>) => validateNavigationData({ ...valid, ...patch });

describe("validateNavigationData", () => {
  it("accepts a valid message and returns an equal copy", () => {
    const r = validateNavigationData(valid);
    expect(r.ok && r.value).toEqual(valid);
  });

  it.each(TURN_DIRECTIONS)("accepts turn direction %s", (d) => {
    expect(bad({ turnDirection: d }).ok).toBe(true);
  });

  it("accepts boundaries: zero speed, zero distance, heading 0, empty route", () => {
    expect(bad({ currentSpeedKmh: 0, distanceToTurnMeters: 0, headingDegrees: 0, routePoints: [] }).ok).toBe(true);
  });

  it("accepts nulls for speed, limit, distance, heading and position", () => {
    expect(
      bad({ currentSpeedKmh: null, speedLimitKmh: null, speedLimitStatus: "UNKNOWN", distanceToTurnMeters: null, latitude: null, longitude: null, headingDegrees: null }).ok,
    ).toBe(true);
  });

  it.each([-1, NaN, Infinity, "50", 500])("rejects invalid speed %s", (v) => {
    expect(bad({ currentSpeedKmh: v }).ok).toBe(false);
  });

  it.each([-5, NaN, -Infinity, "10", 1e9])("rejects invalid distance %s", (v) => {
    expect(bad({ distanceToTurnMeters: v }).ok).toBe(false);
  });

  it.each([-1, 1.5, NaN, "1", null])("rejects invalid sequence %s", (v) => {
    expect(bad({ sequenceNumber: v }).ok).toBe(false);
  });

  it.each([-1, 360, NaN, "N"])("rejects invalid heading %s", (v) => {
    expect(bad({ headingDegrees: v }).ok).toBe(false);
  });

  it("rejects malformed coordinates", () => {
    expect(bad({ latitude: 91 }).ok).toBe(false);
    expect(bad({ longitude: -181 }).ok).toBe(false);
    expect(bad({ latitude: NaN }).ok).toBe(false);
    expect(bad({ longitude: null }).ok).toBe(false); // only one of the pair
  });

  it("rejects malformed route points", () => {
    expect(bad({ routePoints: "x" }).ok).toBe(false);
    expect(bad({ routePoints: [{ latitude: 100, longitude: 0 }] }).ok).toBe(false);
    expect(bad({ routePoints: [null] }).ok).toBe(false);
    expect(bad({ routePoints: [{ latitude: 1 }] }).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => ({ latitude: 1, longitude: 1 }));
    expect(bad({ routePoints: tooMany }).ok).toBe(false);
  });

  it("rejects invalid enums and timestamp", () => {
    expect(bad({ turnDirection: "BACK" }).ok).toBe(false);
    expect(bad({ gpsStatus: "MAYBE" }).ok).toBe(false);
    expect(bad({ bleStatus: 1 }).ok).toBe(false);
    expect(bad({ routeStatus: "NONE" }).ok).toBe(false);
    expect(bad({ speedLimitStatus: "OLD" }).ok).toBe(false);
    expect(bad({ timestamp: NaN }).ok).toBe(false);
  });

  it("rejects malformed speed-limit states", () => {
    expect(bad({ speedLimitStatus: "UNKNOWN" }).ok).toBe(false); // limit present
    expect(bad({ speedLimitKmh: null, speedLimitStatus: "VALID" }).ok).toBe(false);
    expect(bad({ speedLimitKmh: null, speedLimitStatus: "STALE" }).ok).toBe(false);
    expect(bad({ speedLimitKmh: 0 }).ok).toBe(false); // 0 is not "unknown"
  });

  it("rejects non-objects and missing fields", () => {
    for (const v of [null, [], "x", 5, {}]) expect(validateNavigationData(v).ok).toBe(false);
  });
});

describe("packet envelope", () => {
  const packet = { version: PROTOCOL_VERSION, data: valid };
  it("parses valid JSON", () => {
    expect(parseNavigationPacketJson(JSON.stringify(packet)).ok).toBe(true);
  });
  it("rejects invalid JSON without throwing", () => {
    expect(parseNavigationPacketJson("{oops").ok).toBe(false);
  });
  it("rejects wrong version, missing data and bad data", () => {
    expect(validateNavigationPacket({ ...packet, version: 2 }).ok).toBe(false);
    expect(validateNavigationPacket({ version: 1 }).ok).toBe(false);
    expect(validateNavigationPacket({ version: 1, data: { ...valid, currentSpeedKmh: -1 } }).ok).toBe(false);
    expect(validateNavigationPacket(null).ok).toBe(false);
  });
});

describe("isNewerSequence", () => {
  it("accepts first and increasing; rejects duplicate and older", () => {
    expect(isNewerSequence(null, 0)).toBe(true);
    expect(isNewerSequence(5, 6)).toBe(true);
    expect(isNewerSequence(5, 5)).toBe(false);
    expect(isNewerSequence(5, 3)).toBe(false);
  });
});
