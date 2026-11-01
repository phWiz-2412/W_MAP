import {
  parseRouteFixtureJson,
  validateRouteFixture,
  type RouteFixture,
  type ValidationResult,
} from "@w-map/navigation-core";

import urbanStraightRaw from "./vn/urban-straight.json";
import leftRightTurnsRaw from "./vn/left-right-turns.json";
import roundaboutRaw from "./vn/roundabout.json";
import missingRouteRaw from "./vn/missing-route.json";
import gpsLossRaw from "./vn/gps-loss.json";
import staleDataRaw from "./vn/stale-data.json";
import unknownSpeedLimitRaw from "./vn/unknown-speed-limit.json";

const RAW_PRESETS: readonly unknown[] = [
  leftRightTurnsRaw,
  urbanStraightRaw,
  roundaboutRaw,
  missingRouteRaw,
  gpsLossRaw,
  staleDataRaw,
  unknownSpeedLimitRaw,
];

function mustValidatePreset(raw: unknown): RouteFixture {
  const res = validateRouteFixture(raw);
  if (!res.ok) {
    throw new Error(`Invalid built-in route fixture: ${res.errors.join("; ")}`);
  }
  return res.value;
}

/**
 * Built-in deterministic Vietnamese road scenario fixtures.
 * All presets are SYNTHETIC test data (`isSynthetic: true`) and not real Vietnamese map data.
 */
export const VN_ROUTE_FIXTURES: readonly RouteFixture[] = RAW_PRESETS.map(mustValidatePreset);

/** Default fixture matching the baseline simulator scenario. */
export const DEFAULT_VN_FIXTURE: RouteFixture = VN_ROUTE_FIXTURES[0]!;

export function getBuiltInFixtureById(id: string): RouteFixture | undefined {
  return VN_ROUTE_FIXTURES.find((f) => f.id === id);
}

/**
 * Validate and load a RouteFixture from a raw JSON string (e.g. uploaded file or pasted JSON).
 */
export function loadRouteFixtureFromJson(rawJson: string): ValidationResult<RouteFixture> {
  return parseRouteFixtureJson(rawJson);
}
