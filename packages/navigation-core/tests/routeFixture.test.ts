import { describe, expect, it } from "vitest";
import {
  MAX_ROUTE_POINTS,
  ROUTE_FIXTURE_SCHEMA_VERSION,
  interpolateRoutePosition,
  parseRouteFixtureJson,
  resolveStepAtProgress,
  validateRouteFixture,
  type RouteFixture,
} from "../src";

const validFixture: RouteFixture = {
  schemaVersion: ROUTE_FIXTURE_SCHEMA_VERSION,
  id: "vn-test-corridor",
  name: "VN Urban Corridor (Synthetic)",
  description: "SYNTHETIC TEST DATA — not real Vietnamese map data",
  region: "VN-Synthetic",
  isSynthetic: true,
  initialState: {
    currentSpeedKmh: 45,
    gpsStatus: "ACTIVE",
    bleStatus: "CONNECTED",
    routeStatus: "ACTIVE",
    timestampAgeMs: 0,
    progressPercent: 20,
    fallbackPosition: { latitude: 21.0285, longitude: 105.8542 },
  },
  routePoints: [
    { latitude: 21.02, longitude: 105.85 },
    { latitude: 21.03, longitude: 105.85 },
    { latitude: 21.03, longitude: 105.86 },
  ],
  steps: [
    {
      atProgressPercent: 0,
      turnDirection: "STRAIGHT",
      distanceToTurnMeters: 500,
      headingDegrees: 0,
      instruction: "Continue straight (synthetic)",
      speedLimitKmh: 50,
      speedLimitStatus: "VALID",
    },
    {
      atProgressPercent: 50,
      turnDirection: "ROUNDABOUT",
      distanceToTurnMeters: 150,
      headingDegrees: 90,
      instruction: "Enter roundabout (synthetic)",
      speedLimitKmh: 40,
      speedLimitStatus: "VALID",
    },
  ],
  backdropRoads: [
    {
      id: "road-1",
      name: "Pho Chinh (Sim)",
      kind: "MAJOR",
      points: [
        { latitude: 21.01, longitude: 105.85 },
        { latitude: 21.04, longitude: 105.85 },
      ],
    },
  ],
};

const bad = (patch: Record<string, unknown>) => validateRouteFixture({ ...validFixture, ...patch });

describe("validateRouteFixture", () => {
  it("accepts a valid synthetic fixture", () => {
    const res = validateRouteFixture(validFixture);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.isSynthetic).toBe(true);
      expect(res.value.steps).toHaveLength(2);
    }
  });

  it("rejects fixtures where isSynthetic is false or missing", () => {
    expect(bad({ isSynthetic: false }).ok).toBe(false);
    expect(bad({ isSynthetic: "true" }).ok).toBe(false);
  });

  it("rejects wrong schemaVersion or empty metadata", () => {
    expect(bad({ schemaVersion: 2 }).ok).toBe(false);
    expect(bad({ id: "" }).ok).toBe(false);
    expect(bad({ name: "  " }).ok).toBe(false);
    expect(bad({ description: "" }).ok).toBe(false);
    expect(bad({ region: "" }).ok).toBe(false);
  });

  it("rejects invalid routePoints (single point, malformed coords, > MAX_ROUTE_POINTS)", () => {
    expect(bad({ routePoints: [{ latitude: 21, longitude: 105 }] }).ok).toBe(false);
    expect(bad({ routePoints: [{ latitude: 95, longitude: 105 }, { latitude: 21, longitude: 105 }] }).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => ({ latitude: 21, longitude: 105 }));
    expect(bad({ routePoints: tooMany }).ok).toBe(false);
  });

  it("accepts empty routePoints for missing-route scenarios", () => {
    expect(bad({ routePoints: [] }).ok).toBe(true);
  });

  it("rejects empty steps, non-increasing step progress, or inconsistent speed limits", () => {
    expect(bad({ steps: [] }).ok).toBe(false);
    expect(
      bad({
        steps: [
          { ...validFixture.steps[0]!, atProgressPercent: 50 },
          { ...validFixture.steps[1]!, atProgressPercent: 30 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      bad({
        steps: [{ ...validFixture.steps[0]!, speedLimitStatus: "UNKNOWN", speedLimitKmh: 50 }],
      }).ok,
    ).toBe(false);
    expect(
      bad({
        steps: [{ ...validFixture.steps[0]!, speedLimitStatus: "VALID", speedLimitKmh: null }],
      }).ok,
    ).toBe(false);
  });

  it("rejects invalid initialState fields", () => {
    expect(bad({ initialState: { ...validFixture.initialState, currentSpeedKmh: -10 } }).ok).toBe(false);
    expect(bad({ initialState: { ...validFixture.initialState, timestampAgeMs: -1 } }).ok).toBe(false);
    expect(bad({ initialState: { ...validFixture.initialState, progressPercent: 120 } }).ok).toBe(false);
    expect(bad({ initialState: { ...validFixture.initialState, fallbackPosition: { latitude: 200, longitude: 0 } } }).ok).toBe(false);
  });

  it("parses valid JSON and rejects malformed JSON without throwing", () => {
    expect(parseRouteFixtureJson(JSON.stringify(validFixture)).ok).toBe(true);
    expect(parseRouteFixtureJson("{bad json").ok).toBe(false);
  });
});

describe("resolveStepAtProgress & interpolateRoutePosition", () => {
  it("resolves active step by progress threshold", () => {
    expect(resolveStepAtProgress(validFixture.steps, 0).turnDirection).toBe("STRAIGHT");
    expect(resolveStepAtProgress(validFixture.steps, 49).turnDirection).toBe("STRAIGHT");
    expect(resolveStepAtProgress(validFixture.steps, 50).turnDirection).toBe("ROUNDABOUT");
    expect(resolveStepAtProgress(validFixture.steps, 100).turnDirection).toBe("ROUNDABOUT");
  });

  it("interpolates along routePoints and uses fallback when empty", () => {
    const start = interpolateRoutePosition(validFixture.routePoints, 0);
    expect(start).toEqual({ latitude: 21.02, longitude: 105.85 });
    const mid = interpolateRoutePosition(validFixture.routePoints, 50);
    expect(mid?.latitude).toBeCloseTo(21.03, 4);
    expect(mid?.longitude).toBeCloseTo(105.85, 4);
    const end = interpolateRoutePosition(validFixture.routePoints, 100);
    expect(end).toEqual({ latitude: 21.03, longitude: 105.86 });

    const fallback = { latitude: 16.05, longitude: 108.2 };
    expect(interpolateRoutePosition([], 50, fallback)).toEqual(fallback);
    expect(interpolateRoutePosition([], 50, null)).toBeNull();
  });
});
