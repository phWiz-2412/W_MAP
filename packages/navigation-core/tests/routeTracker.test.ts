import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE_PROGRESS_CONFIG,
  INITIAL_ROUTE_TRACKER,
  compactRouteGeometry,
  evaluateRouteProgress,
  fromLocalMeters,
  pointToSegmentDistanceMeters,
  validateCalculatedRoute,
  type CalculatedRoute,
  type RoutePoint,
} from "../src";

const origin: RoutePoint = { latitude: 21.0285, longitude: 105.8542 };
const turn1 = fromLocalMeters(origin, 0, 300); // 300m north
const turn2 = fromLocalMeters(origin, 300, 300); // 300m east of turn1
const dest = fromLocalMeters(origin, 300, 600); // 300m north of turn2

const sampleRoute: CalculatedRoute = {
  routeId: "test-route-1",
  providerId: "synthetic-vn-fixture",
  isSynthetic: true,
  attribution: "Synthetic test route",
  calculatedAtMs: 1000,
  origin,
  destination: dest,
  totalDistanceMeters: 900,
  estimatedDurationSeconds: 90,
  geometry: [origin, turn1, turn2, dest],
  steps: [
    {
      turnDirection: "RIGHT",
      maneuverLocation: turn1,
      distanceMeters: 300,
      durationSeconds: 30,
      headingDegrees: 0,
      instruction: "Proceed north 300m then turn right",
      speedLimitKmh: null,
      speedLimitStatus: "UNKNOWN",
    },
    {
      turnDirection: "LEFT",
      maneuverLocation: turn2,
      distanceMeters: 300,
      durationSeconds: 30,
      headingDegrees: 90,
      instruction: "Proceed east 300m then turn left",
      speedLimitKmh: null,
      speedLimitStatus: "UNKNOWN",
    },
    {
      turnDirection: "STRAIGHT",
      maneuverLocation: dest,
      distanceMeters: 300,
      durationSeconds: 30,
      headingDegrees: 0,
      instruction: "Arrive at destination",
      speedLimitKmh: null,
      speedLimitStatus: "UNKNOWN",
    },
  ],
};

describe("validateCalculatedRoute", () => {
  it("accepts a valid route and enforces UNKNOWN speed limit consistency", () => {
    const res = validateCalculatedRoute(sampleRoute);
    expect(res.ok).toBe(true);
  });

  it("rejects empty geometry, missing steps, or invalid speed limit states", () => {
    expect(validateCalculatedRoute(null).ok).toBe(false);
    expect(validateCalculatedRoute({ ...sampleRoute, geometry: [origin] }).ok).toBe(false);
    expect(validateCalculatedRoute({ ...sampleRoute, steps: [] }).ok).toBe(false);
    expect(
      validateCalculatedRoute({
        ...sampleRoute,
        steps: [{ ...sampleRoute.steps[0]!, speedLimitStatus: "UNKNOWN", speedLimitKmh: 50 }],
      }).ok,
    ).toBe(false);
  });
});

describe("pointToSegmentDistanceMeters & compactRouteGeometry", () => {
  it("computes cross-track distance accurately", () => {
    const p = fromLocalMeters(origin, 25, 150); // 25m east of midpoint of first north segment
    const seg = pointToSegmentDistanceMeters(p, origin, turn1);
    expect(seg.distanceMeters).toBeCloseTo(25, 0);
    expect(seg.t).toBeCloseTo(0.5, 1);
  });

  it("compacts route polylines exceeding maxPoints down to <= 64 points", () => {
    const longGeom = Array.from({ length: 120 }, (_, i) => fromLocalMeters(origin, 0, i * 10));
    const compact = compactRouteGeometry(longGeom, 10, 64);
    expect(compact.length).toBeLessThanOrEqual(64);
    expect(compact.at(-1)).toEqual(longGeom.at(-1));
  });
});

describe("evaluateRouteProgress", () => {
  it("calculates distance to next maneuver and advances steps when passing junction", () => {
    const mid1 = fromLocalMeters(origin, 0, 150);
    const ev1 = evaluateRouteProgress(sampleRoute, mid1, 6, "ACTIVE", INITIAL_ROUTE_TRACKER);
    expect(ev1.isProgressCurrent).toBe(true);
    expect(ev1.activeStep.turnDirection).toBe("RIGHT");
    expect(ev1.distanceToNextTurnMeters).toBeCloseTo(150, -1);

    // Move within 15m of turn1 -> advances to step index 1 (LEFT at turn2)
    const nearTurn1 = fromLocalMeters(origin, 0, 290);
    const ev2 = evaluateRouteProgress(sampleRoute, nearTurn1, 6, "ACTIVE", ev1.tracker);
    expect(ev2.tracker.activeStepIndex).toBe(1);
    expect(ev2.activeStep.turnDirection).toBe("LEFT");
  });

  it("ignores single-sample GPS drift near an intersection and requires consecutive samples for off-route", () => {
    // 1 noisy sample 80m east of the route
    const driftPos = fromLocalMeters(origin, 80, 150);
    const ev1 = evaluateRouteProgress(sampleRoute, driftPos, 5, "ACTIVE", INITIAL_ROUTE_TRACKER);
    expect(ev1.isOffRoute).toBe(false);
    expect(ev1.tracker.offRouteSamples).toBe(1);

    // Next sample returns to route -> counter resets to 0
    const onRoutePos = fromLocalMeters(origin, 3, 160);
    const ev2 = evaluateRouteProgress(sampleRoute, onRoutePos, 5, "ACTIVE", ev1.tracker);
    expect(ev2.isOffRoute).toBe(false);
    expect(ev2.tracker.offRouteSamples).toBe(0);

    // 3 consecutive off-route samples -> triggers isOffRoute = true
    const off1 = evaluateRouteProgress(sampleRoute, driftPos, 5, "ACTIVE", INITIAL_ROUTE_TRACKER);
    const off2 = evaluateRouteProgress(sampleRoute, driftPos, 5, "ACTIVE", off1.tracker);
    const off3 = evaluateRouteProgress(sampleRoute, driftPos, 5, "ACTIVE", off2.tracker);
    expect(off2.isOffRoute).toBe(false);
    expect(off3.isOffRoute).toBe(true);
  });

  it("does not advance progress or declare arrival when GPS is LOST", () => {
    const atDest = dest;
    const evLost = evaluateRouteProgress(sampleRoute, atDest, 5, "LOST", INITIAL_ROUTE_TRACKER);
    expect(evLost.isProgressCurrent).toBe(false);
    expect(evLost.hasArrived).toBe(false);
    expect(evLost.isOffRoute).toBe(false);
  });

  it("requires consecutive proximity samples before declaring destination arrived", () => {
    const nearDest = fromLocalMeters(origin, 300, 590); // 10m from destination
    const a1 = evaluateRouteProgress(
      sampleRoute,
      nearDest,
      5,
      "ACTIVE",
      { ...INITIAL_ROUTE_TRACKER, activeStepIndex: 2 },
      DEFAULT_ROUTE_PROGRESS_CONFIG,
    );
    expect(a1.hasArrived).toBe(false);
    expect(a1.tracker.arrivalSamples).toBe(1);

    const a2 = evaluateRouteProgress(sampleRoute, nearDest, 5, "ACTIVE", a1.tracker, DEFAULT_ROUTE_PROGRESS_CONFIG);
    expect(a2.hasArrived).toBe(true);
    expect(a2.distanceToNextTurnMeters).toBe(0);
    expect(a2.remainingDistanceMeters).toBe(0);
  });
});
