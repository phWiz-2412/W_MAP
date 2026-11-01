import {
  MAX_DISTANCE_METERS,
  MAX_ROUTE_POINTS,
  MAX_SPEED_KMH,
  MAX_SPEED_LIMIT_KMH,
  TURN_DIRECTIONS,
  type BLEStatus,
  type GPSStatus,
  type RoutePoint,
  type RouteStatus,
  type SpeedLimitStatus,
  type TurnDirection,
  type ValidationResult,
} from "../index";

export const ROUTE_FIXTURE_SCHEMA_VERSION = 1 as const;

export interface BackdropRoad {
  id: string;
  name?: string;
  kind: "MAJOR" | "MINOR";
  points: readonly RoutePoint[];
}

export interface RouteStepFixture {
  /** Progress threshold [0..100] from which this step is active until the next step's atProgressPercent. */
  atProgressPercent: number;
  turnDirection: TurnDirection;
  distanceToTurnMeters: number | null;
  headingDegrees: number | null;
  instruction?: string;
  speedLimitKmh: number | null;
  speedLimitStatus: SpeedLimitStatus;
}

export interface RouteFixtureInitialState {
  currentSpeedKmh: number | null;
  gpsStatus: GPSStatus;
  bleStatus: BLEStatus;
  routeStatus: RouteStatus;
  /** Offset in ms subtracted from receiver clock to simulate stale or live packets. 0 = live. */
  timestampAgeMs: number;
  /** Initial progress along route [0..100]. */
  progressPercent: number;
  /** Fallback position when routePoints is empty (e.g., missing-route or GPS-loss scenario). */
  fallbackPosition: RoutePoint | null;
}

/**
 * Validated local JSON fixture for deterministic route and scenario testing.
 * Must always specify `isSynthetic: true` so simulated routes are never mistaken for real map data.
 */
export interface RouteFixture {
  schemaVersion: typeof ROUTE_FIXTURE_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  region: string;
  isSynthetic: true;
  initialState: RouteFixtureInitialState;
  routePoints: RoutePoint[];
  steps: RouteStepFixture[];
  backdropRoads?: BackdropRoad[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isOneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === "string" && (options as readonly string[]).includes(v);

function isValidCoord(p: unknown): p is RoutePoint {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const r = p as Record<string, unknown>;
  return (
    isNum(r.latitude) &&
    isNum(r.longitude) &&
    r.latitude >= -90 &&
    r.latitude <= 90 &&
    r.longitude >= -180 &&
    r.longitude <= 180
  );
}

function validatePointsArray(v: unknown, label: string, maxLen: number, errors: string[]): RoutePoint[] {
  if (!Array.isArray(v)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  if (v.length > maxLen) {
    errors.push(`${label} must contain at most ${maxLen} points`);
    return [];
  }
  const out: RoutePoint[] = [];
  v.forEach((pt, idx) => {
    if (!isValidCoord(pt)) {
      errors.push(`${label}[${idx}] has malformed coordinates`);
    } else {
      out.push({ latitude: pt.latitude, longitude: pt.longitude });
    }
  });
  return out;
}

function validateSteps(v: unknown, errors: string[]): RouteStepFixture[] {
  if (!Array.isArray(v) || v.length === 0) {
    errors.push("steps must be a non-empty array");
    return [];
  }
  const out: RouteStepFixture[] = [];
  let prevProgress = -1;
  v.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`steps[${i}] must be an object`);
      return;
    }
    const s = raw as Record<string, unknown>;
    if (!isNum(s.atProgressPercent) || s.atProgressPercent < 0 || s.atProgressPercent > 100) {
      errors.push(`steps[${i}].atProgressPercent must be in 0..100`);
    } else if (s.atProgressPercent <= prevProgress) {
      errors.push(`steps[${i}].atProgressPercent must be strictly increasing`);
    } else {
      prevProgress = s.atProgressPercent;
    }
    if (!isOneOf(s.turnDirection, TURN_DIRECTIONS)) {
      errors.push(`steps[${i}].turnDirection is invalid`);
    }
    if (
      s.distanceToTurnMeters !== null &&
      !(isNum(s.distanceToTurnMeters) && s.distanceToTurnMeters >= 0 && s.distanceToTurnMeters <= MAX_DISTANCE_METERS)
    ) {
      errors.push(`steps[${i}].distanceToTurnMeters must be null or in 0..${MAX_DISTANCE_METERS}`);
    }
    if (s.headingDegrees !== null && !(isNum(s.headingDegrees) && s.headingDegrees >= 0 && s.headingDegrees < 360)) {
      errors.push(`steps[${i}].headingDegrees must be null or in [0, 360)`);
    }
    if (s.instruction !== undefined && typeof s.instruction !== "string") {
      errors.push(`steps[${i}].instruction must be a string if provided`);
    }
    if (
      s.speedLimitKmh !== null &&
      !(isNum(s.speedLimitKmh) && s.speedLimitKmh > 0 && s.speedLimitKmh <= MAX_SPEED_LIMIT_KMH)
    ) {
      errors.push(`steps[${i}].speedLimitKmh must be null or in (0..${MAX_SPEED_LIMIT_KMH}]`);
    }
    if (!isOneOf(s.speedLimitStatus, ["VALID", "UNKNOWN", "STALE"] as const)) {
      errors.push(`steps[${i}].speedLimitStatus is invalid`);
    } else {
      if (s.speedLimitStatus === "UNKNOWN" && s.speedLimitKmh !== null) {
        errors.push(`steps[${i}]: speedLimitStatus UNKNOWN requires speedLimitKmh null`);
      }
      if (s.speedLimitStatus !== "UNKNOWN" && s.speedLimitKmh === null) {
        errors.push(`steps[${i}]: speedLimitStatus ${s.speedLimitStatus} requires a speedLimitKmh value`);
      }
    }

    out.push({
      atProgressPercent: s.atProgressPercent as number,
      turnDirection: s.turnDirection as TurnDirection,
      distanceToTurnMeters: s.distanceToTurnMeters as number | null,
      headingDegrees: s.headingDegrees as number | null,
      ...(typeof s.instruction === "string" ? { instruction: s.instruction } : {}),
      speedLimitKmh: s.speedLimitKmh as number | null,
      speedLimitStatus: s.speedLimitStatus as SpeedLimitStatus,
    });
  });
  return out;
}

function validateBackdropRoads(v: unknown, errors: string[]): BackdropRoad[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push("backdropRoads must be an array if provided");
    return undefined;
  }
  const out: BackdropRoad[] = [];
  v.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`backdropRoads[${i}] must be an object`);
      return;
    }
    const r = raw as Record<string, unknown>;
    if (!isNonEmptyStr(r.id)) errors.push(`backdropRoads[${i}].id must be a non-empty string`);
    if (r.name !== undefined && typeof r.name !== "string") {
      errors.push(`backdropRoads[${i}].name must be a string`);
    }
    if (!isOneOf(r.kind, ["MAJOR", "MINOR"] as const)) {
      errors.push(`backdropRoads[${i}].kind must be MAJOR or MINOR`);
    }
    const pts = validatePointsArray(r.points, `backdropRoads[${i}].points`, MAX_ROUTE_POINTS, errors);
    if (Array.isArray(r.points) && pts.length < 2) {
      errors.push(`backdropRoads[${i}].points must have at least 2 points`);
    }
    out.push({
      id: r.id as string,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      kind: r.kind as "MAJOR" | "MINOR",
      points: pts,
    });
  });
  return out;
}

/** Validate an untrusted object as a RouteFixture. */
export function validateRouteFixture(input: unknown): ValidationResult<RouteFixture> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["fixture must be an object"] };
  }
  const f = input as Record<string, unknown>;
  const errors: string[] = [];

  if (f.schemaVersion !== ROUTE_FIXTURE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ROUTE_FIXTURE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyStr(f.id)) errors.push("id must be a non-empty string");
  if (!isNonEmptyStr(f.name)) errors.push("name must be a non-empty string");
  if (!isNonEmptyStr(f.description)) errors.push("description must be a non-empty string");
  if (!isNonEmptyStr(f.region)) errors.push("region must be a non-empty string");
  if (f.isSynthetic !== true) {
    errors.push("isSynthetic must be true (fixtures must be explicitly labeled as synthetic test data)");
  }

  let initialState: RouteFixtureInitialState | null = null;
  if (typeof f.initialState !== "object" || f.initialState === null || Array.isArray(f.initialState)) {
    errors.push("initialState must be an object");
  } else {
    const s = f.initialState as Record<string, unknown>;
    if (s.currentSpeedKmh !== null && !(isNum(s.currentSpeedKmh) && s.currentSpeedKmh >= 0 && s.currentSpeedKmh <= MAX_SPEED_KMH)) {
      errors.push(`initialState.currentSpeedKmh must be null or in 0..${MAX_SPEED_KMH}`);
    }
    if (!isOneOf(s.gpsStatus, ["ACTIVE", "LOST"] as const)) errors.push("initialState.gpsStatus is invalid");
    if (!isOneOf(s.bleStatus, ["CONNECTED", "DISCONNECTED"] as const)) errors.push("initialState.bleStatus is invalid");
    if (!isOneOf(s.routeStatus, ["ACTIVE", "INACTIVE"] as const)) errors.push("initialState.routeStatus is invalid");
    if (!isNum(s.timestampAgeMs) || s.timestampAgeMs < 0) {
      errors.push("initialState.timestampAgeMs must be a non-negative finite number");
    }
    if (!isNum(s.progressPercent) || s.progressPercent < 0 || s.progressPercent > 100) {
      errors.push("initialState.progressPercent must be in 0..100");
    }
    let fallback: RoutePoint | null = null;
    if (s.fallbackPosition !== null) {
      if (!isValidCoord(s.fallbackPosition)) {
        errors.push("initialState.fallbackPosition must be null or valid coordinates");
      } else {
        fallback = { latitude: s.fallbackPosition.latitude, longitude: s.fallbackPosition.longitude };
      }
    }
    initialState = {
      currentSpeedKmh: s.currentSpeedKmh as number | null,
      gpsStatus: s.gpsStatus as GPSStatus,
      bleStatus: s.bleStatus as BLEStatus,
      routeStatus: s.routeStatus as RouteStatus,
      timestampAgeMs: s.timestampAgeMs as number,
      progressPercent: s.progressPercent as number,
      fallbackPosition: fallback,
    };
  }

  const routePoints = validatePointsArray(f.routePoints, "routePoints", MAX_ROUTE_POINTS, errors);
  if (Array.isArray(f.routePoints) && f.routePoints.length === 1) {
    errors.push("routePoints must be empty or contain at least 2 points");
  }
  const steps = validateSteps(f.steps, errors);
  const backdropRoads = validateBackdropRoads(f.backdropRoads, errors);

  if (errors.length > 0 || !initialState) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion: ROUTE_FIXTURE_SCHEMA_VERSION,
      id: f.id as string,
      name: f.name as string,
      description: f.description as string,
      region: f.region as string,
      isSynthetic: true,
      initialState,
      routePoints,
      steps,
      ...(backdropRoads !== undefined ? { backdropRoads } : {}),
    },
  };
}

/** Parse a JSON string and validate it as a RouteFixture. Never throws. */
export function parseRouteFixtureJson(raw: string): ValidationResult<RouteFixture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["fixture is not valid JSON"] };
  }
  return validateRouteFixture(parsed);
}

/**
 * Evaluate the active step at a given route progress percentage (0..100).
 * Picks the last step whose `atProgressPercent <= progressPercent`, or the first step.
 */
export function resolveStepAtProgress(steps: readonly RouteStepFixture[], progressPercent: number): RouteStepFixture {
  const clamped = Math.min(100, Math.max(0, progressPercent));
  let active = steps[0]!;
  for (const step of steps) {
    if (step.atProgressPercent <= clamped) {
      active = step;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Interpolate geographic position along a sequence of route points at `progressPercent` (0..100).
 * Returns `fallback` if `routePoints` has fewer than 2 points.
 */
export function interpolateRoutePosition(
  routePoints: readonly RoutePoint[],
  progressPercent: number,
  fallback: RoutePoint | null = null,
): RoutePoint | null {
  if (routePoints.length === 0) return fallback;
  if (routePoints.length === 1) return routePoints[0]!;
  const p = Math.min(100, Math.max(0, progressPercent)) / 100;
  const segLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < routePoints.length; i++) {
    const a = routePoints[i - 1]!;
    const b = routePoints[i]!;
    const len = Math.hypot(b.latitude - a.latitude, b.longitude - a.longitude);
    segLengths.push(len);
    total += len;
  }
  if (total === 0) return routePoints[0]!;
  let remaining = p * total;
  for (let i = 0; i < segLengths.length; i++) {
    const len = segLengths[i]!;
    if (remaining <= len || i === segLengths.length - 1) {
      const a = routePoints[i]!;
      const b = routePoints[i + 1]!;
      const t = len === 0 ? 0 : Math.min(1, remaining / len);
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      };
    }
    remaining -= len;
  }
  return routePoints[routePoints.length - 1]!;
}
