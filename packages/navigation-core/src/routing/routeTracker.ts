import {
  MAX_DISTANCE_METERS,
  MAX_ROUTE_POINTS,
  TURN_DIRECTIONS,
  type GPSStatus,
  type RoutePoint,
  type SpeedLimitStatus,
  type TurnDirection,
  type ValidationResult,
} from "../index";
import { haversineDistanceMeters } from "../live/gpsFix";

export interface RouteStepModel {
  turnDirection: TurnDirection;
  maneuverLocation: RoutePoint;
  distanceMeters: number;
  durationSeconds: number | null;
  headingDegrees: number | null;
  instruction: string;
  /** Optional street/road name extracted from routing step when available. */
  streetName?: string | null;
  /** Always null unless a verified speed-limit source is explicitly used. */
  speedLimitKmh: number | null;
  speedLimitStatus: SpeedLimitStatus;
}

export const ROUTE_TRAVEL_MODES = ["TWO_WHEELER", "DRIVE"] as const;
export type RouteTravelMode = (typeof ROUTE_TRAVEL_MODES)[number];

/**
 * Supported routing preferences.
 * Note: Google Maps Platform Routes API v2 supports `avoidHighways`, `avoidTolls`, and `avoidFerries`
 * on `DRIVE` and `TWO_WHEELER` travel modes, but does NOT provide a verified "avoid car-only lanes"
 * modifier or guaranteed legal motorcycle road restriction data in Vietnam.
 */
export interface RoutePreferences {
  travelMode: RouteTravelMode;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
}

export const DEFAULT_ROUTE_PREFERENCES: RoutePreferences = {
  travelMode: "TWO_WHEELER",
  avoidHighways: true,
  avoidTolls: false,
  avoidFerries: false,
};

/**
 * Decode a Google Maps Platform Encoded Polyline string (precision 1e-5) into `RoutePoint[]`.
 * Throws an error if the encoded string is empty, truncated, or produces out-of-range coordinates.
 */
export function decodeGooglePolyline(encoded: string): RoutePoint[] {
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    throw new Error("Encoded polyline must be a non-empty string");
  }
  const points: RoutePoint[] = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= len) {
        throw new Error("Truncated encoded polyline (latitude)");
      }
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) {
        throw new Error("Invalid character in encoded polyline");
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      if (index >= len) {
        throw new Error("Truncated encoded polyline (longitude)");
      }
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) {
        throw new Error("Invalid character in encoded polyline");
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    const latitude = Number((lat / 1e5).toFixed(6));
    const longitude = Number((lng / 1e5).toFixed(6));
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error(`Decoded polyline coordinate out of bounds: (${latitude}, ${longitude})`);
    }
    points.push({ latitude, longitude });
  }

  return points;
}

/**
 * Encode `RoutePoint[]` into a Google Encoded Polyline string (precision 1e-5) for deterministic tests.
 */
export function encodeGooglePolyline(points: readonly RoutePoint[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";

  const encodeSigned = (num: number): string => {
    let s = num < 0 ? ~(num << 1) : num << 1;
    let out = "";
    while (s >= 0x20) {
      out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    out += String.fromCharCode(s + 63);
    return out;
  };

  for (const pt of points) {
    const lat = Math.round(pt.latitude * 1e5);
    const lng = Math.round(pt.longitude * 1e5);
    result += encodeSigned(lat - lastLat);
    result += encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return result;
}

export type RouteProviderStatus =
  | "IDLE"
  | "CALCULATING"
  | "ACTIVE"
  | "REROUTING"
  | "ARRIVED"
  | "OFF_ROUTE"
  | "UNAVAILABLE"
  | "ERROR";

export interface CalculatedRoute {
  routeId: string;
  providerId: string;
  isSynthetic: boolean;
  attribution: string;
  calculatedAtMs: number;
  origin: RoutePoint;
  destination: RoutePoint;
  totalDistanceMeters: number;
  estimatedDurationSeconds: number | null;
  /** Full polyline geometry for the route-planning map. */
  geometry: RoutePoint[];
  /** Ordered turn-by-turn steps. */
  steps: RouteStepModel[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isOneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === "string" && (options as readonly string[]).includes(v);

function isValidPoint(v: unknown): v is RoutePoint {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    isNum(p.latitude) &&
    isNum(p.longitude) &&
    p.latitude >= -90 &&
    p.latitude <= 90 &&
    p.longitude >= -180 &&
    p.longitude <= 180
  );
}

/** Validate an external or provider-returned route response before using it. */
export function validateCalculatedRoute(input: unknown): ValidationResult<CalculatedRoute> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["route must be an object"] };
  }
  const r = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyStr(r.routeId)) errors.push("routeId must be a non-empty string");
  if (!isNonEmptyStr(r.providerId)) errors.push("providerId must be a non-empty string");
  if (typeof r.isSynthetic !== "boolean") errors.push("isSynthetic must be a boolean");
  if (!isNonEmptyStr(r.attribution)) errors.push("attribution must be a non-empty string");
  if (!isNum(r.calculatedAtMs) || r.calculatedAtMs < 0) errors.push("calculatedAtMs must be >= 0");
  if (!isValidPoint(r.origin)) errors.push("origin has malformed coordinates");
  if (!isValidPoint(r.destination)) errors.push("destination has malformed coordinates");
  if (!isNum(r.totalDistanceMeters) || r.totalDistanceMeters < 0) {
    errors.push("totalDistanceMeters must be >= 0");
  }
  if (r.estimatedDurationSeconds !== null && !(isNum(r.estimatedDurationSeconds) && r.estimatedDurationSeconds >= 0)) {
    errors.push("estimatedDurationSeconds must be >= 0 or null");
  }

  const geometry: RoutePoint[] = [];
  if (!Array.isArray(r.geometry) || r.geometry.length < 2) {
    errors.push("geometry must be an array with at least 2 points");
  } else {
    r.geometry.forEach((pt, idx) => {
      if (!isValidPoint(pt)) errors.push(`geometry[${idx}] has malformed coordinates`);
      else geometry.push({ latitude: pt.latitude, longitude: pt.longitude });
    });
  }

  const steps: RouteStepModel[] = [];
  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    r.steps.forEach((raw, idx) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(`steps[${idx}] must be an object`);
        return;
      }
      const s = raw as Record<string, unknown>;
      if (!isOneOf(s.turnDirection, TURN_DIRECTIONS)) errors.push(`steps[${idx}].turnDirection is invalid`);
      if (!isValidPoint(s.maneuverLocation)) errors.push(`steps[${idx}].maneuverLocation is invalid`);
      if (!isNum(s.distanceMeters) || s.distanceMeters < 0 || s.distanceMeters > MAX_DISTANCE_METERS) {
        errors.push(`steps[${idx}].distanceMeters is invalid`);
      }
      if (s.durationSeconds !== null && !(isNum(s.durationSeconds) && s.durationSeconds >= 0)) {
        errors.push(`steps[${idx}].durationSeconds must be >= 0 or null`);
      }
      if (s.headingDegrees !== null && !(isNum(s.headingDegrees) && s.headingDegrees >= 0 && s.headingDegrees < 360)) {
        errors.push(`steps[${idx}].headingDegrees must be in [0, 360) or null`);
      }
      if (!isNonEmptyStr(s.instruction)) errors.push(`steps[${idx}].instruction must be a non-empty string`);
      if (!isOneOf(s.speedLimitStatus, ["VALID", "UNKNOWN", "STALE"] as const)) {
        errors.push(`steps[${idx}].speedLimitStatus is invalid`);
      } else {
        if (s.speedLimitStatus === "UNKNOWN" && s.speedLimitKmh !== null) {
          errors.push(`steps[${idx}]: UNKNOWN speedLimitStatus requires speedLimitKmh null`);
        }
        if (s.speedLimitStatus !== "UNKNOWN" && !(isNum(s.speedLimitKmh) && s.speedLimitKmh > 0 && s.speedLimitKmh <= 200)) {
          errors.push(`steps[${idx}]: VALID/STALE speedLimitStatus requires speedLimitKmh in (0..200]`);
        }
      }

      if (errors.length === 0) {
        steps.push({
          turnDirection: s.turnDirection as TurnDirection,
          maneuverLocation: {
            latitude: (s.maneuverLocation as RoutePoint).latitude,
            longitude: (s.maneuverLocation as RoutePoint).longitude,
          },
          distanceMeters: s.distanceMeters as number,
          durationSeconds: s.durationSeconds as number | null,
          headingDegrees: s.headingDegrees as number | null,
          instruction: s.instruction as string,
          speedLimitKmh: s.speedLimitKmh as number | null,
          speedLimitStatus: s.speedLimitStatus as SpeedLimitStatus,
        });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      routeId: r.routeId as string,
      providerId: r.providerId as string,
      isSynthetic: r.isSynthetic as boolean,
      attribution: r.attribution as string,
      calculatedAtMs: r.calculatedAtMs as number,
      origin: { latitude: (r.origin as RoutePoint).latitude, longitude: (r.origin as RoutePoint).longitude },
      destination: {
        latitude: (r.destination as RoutePoint).latitude,
        longitude: (r.destination as RoutePoint).longitude,
      },
      totalDistanceMeters: r.totalDistanceMeters as number,
      estimatedDurationSeconds: r.estimatedDurationSeconds as number | null,
      geometry,
      steps,
    },
  };
}

/**
 * Shortest distance in meters from `point` to segment `a -> b`, plus the closest point on the segment
 * and fraction `t` in `[0, 1]`.
 */
export function pointToSegmentDistanceMeters(
  point: RoutePoint,
  a: RoutePoint,
  b: RoutePoint,
): { distanceMeters: number; t: number; closestPoint: RoutePoint } {
  const cosLat = Math.cos((point.latitude * Math.PI) / 180);
  const px = point.longitude * cosLat;
  const py = point.latitude;
  const ax = a.longitude * cosLat;
  const ay = a.latitude;
  const bx = b.longitude * cosLat;
  const by = b.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closestPoint: RoutePoint = {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
  return {
    distanceMeters: haversineDistanceMeters(point.latitude, point.longitude, closestPoint.latitude, closestPoint.longitude),
    t,
    closestPoint,
  };
}

/**
 * Downsample or slice a route polyline around `closestSegmentIndex` so it fits within `MAX_ROUTE_POINTS` (64)
 * for the compact 240x240 display without exceeding BLE packet limits.
 */
export function compactRouteGeometry(
  geometry: readonly RoutePoint[],
  closestSegmentIndex: number,
  maxPoints: number = MAX_ROUTE_POINTS,
): RoutePoint[] {
  if (geometry.length <= maxPoints) return [...geometry];
  const startIdx = Math.max(0, closestSegmentIndex - 4);
  const windowSlice = geometry.slice(startIdx);
  if (windowSlice.length <= maxPoints) return windowSlice;
  const out: RoutePoint[] = [];
  const stride = (windowSlice.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) {
    out.push(windowSlice[Math.floor(i * stride)]!);
  }
  out.push(windowSlice[windowSlice.length - 1]!);
  return out;
}

export interface RouteProgressConfig {
  /** Base off-route threshold in meters (expanded by GPS accuracy). */
  offRouteThresholdMeters: number;
  /** Number of consecutive off-route GPS samples required before triggering reroute. */
  offRouteConsecutiveSamples: number;
  /** Distance to destination (meters) to consider arrival candidate. */
  arrivalRadiusMeters: number;
  /** Number of consecutive arrival-radius samples required before declaring ARRIVED. */
  arrivalConsecutiveSamples: number;
  /** Distance to a step's maneuver location within which the tracker advances to the next step. */
  stepAdvanceRadiusMeters: number;
}

export const DEFAULT_ROUTE_PROGRESS_CONFIG: RouteProgressConfig = {
  offRouteThresholdMeters: 50,
  offRouteConsecutiveSamples: 3,
  arrivalRadiusMeters: 25,
  arrivalConsecutiveSamples: 2,
  stepAdvanceRadiusMeters: 25,
};

export interface RouteTrackerState {
  activeStepIndex: number;
  offRouteSamples: number;
  arrivalSamples: number;
  arrived: boolean;
  lastProgressPercent: number;
}

export const INITIAL_ROUTE_TRACKER: RouteTrackerState = {
  activeStepIndex: 0,
  offRouteSamples: 0,
  arrivalSamples: 0,
  arrived: false,
  lastProgressPercent: 0,
};

export interface RouteProgressEvaluation {
  tracker: RouteTrackerState;
  /** Whether current progress is verified from a live GPS fix. False when GPS is LOST. */
  isProgressCurrent: boolean;
  /** True when off-route threshold has been exceeded for `offRouteConsecutiveSamples` consecutive fixes. */
  isOffRoute: boolean;
  /** True when destination proximity has been satisfied for `arrivalConsecutiveSamples` consecutive fixes. */
  hasArrived: boolean;
  /** Minimum distance in meters from current position to the route polyline. */
  crossTrackDistanceMeters: number;
  /** Active step for display. */
  activeStep: RouteStepModel;
  /** Distance in meters from current position to the active maneuver. */
  distanceToNextTurnMeters: number;
  /** Remaining distance to destination in meters. */
  remainingDistanceMeters: number;
  /** Compacted route points (<= 64 points) suitable for `NavigationData.routePoints`. */
  compactRoutePoints: RoutePoint[];
}

/**
 * Pure, deterministic route progress evaluator.
 * - Does not advance progress, trigger off-route, or declare arrival when `gpsStatus === "LOST"`.
 * - Requires consecutive valid samples before declaring `isOffRoute` or `hasArrived` to prevent
 *   single-sample GPS drift near intersections from causing false reroutes or premature arrival.
 */
export function evaluateRouteProgress(
  route: CalculatedRoute,
  position: RoutePoint,
  accuracyMeters: number | null,
  gpsStatus: GPSStatus,
  previous: RouteTrackerState = INITIAL_ROUTE_TRACKER,
  config: RouteProgressConfig = DEFAULT_ROUTE_PROGRESS_CONFIG,
): RouteProgressEvaluation {
  const safeStepIdx = Math.min(route.steps.length - 1, Math.max(0, previous.activeStepIndex));
  const currentStep = route.steps[safeStepIdx]!;

  if (gpsStatus !== "ACTIVE") {
    const distToTurn = Math.round(
      haversineDistanceMeters(
        position.latitude,
        position.longitude,
        currentStep.maneuverLocation.latitude,
        currentStep.maneuverLocation.longitude,
      ),
    );
    return {
      tracker: previous,
      isProgressCurrent: false,
      isOffRoute: false,
      hasArrived: previous.arrived,
      crossTrackDistanceMeters: 0,
      activeStep: currentStep,
      distanceToNextTurnMeters: distToTurn,
      remainingDistanceMeters: Math.round(
        haversineDistanceMeters(
          position.latitude,
          position.longitude,
          route.destination.latitude,
          route.destination.longitude,
        ),
      ),
      compactRoutePoints: compactRouteGeometry(route.geometry, 0),
    };
  }

  // 1. Find closest segment on route geometry
  let minCrossTrack = Infinity;
  let closestSegIdx = 0;
  for (let i = 0; i < route.geometry.length - 1; i++) {
    const seg = pointToSegmentDistanceMeters(position, route.geometry[i]!, route.geometry[i + 1]!);
    if (seg.distanceMeters < minCrossTrack) {
      minCrossTrack = seg.distanceMeters;
      closestSegIdx = i;
    }
  }

  // 2. Check destination proximity (requires consecutive valid samples)
  const distToDest = haversineDistanceMeters(
    position.latitude,
    position.longitude,
    route.destination.latitude,
    route.destination.longitude,
  );
  const effectiveArrivalRadius = Math.max(config.arrivalRadiusMeters, Math.min(50, (accuracyMeters ?? 10) * 1.2));
  const arrivalSamples = distToDest <= effectiveArrivalRadius ? previous.arrivalSamples + 1 : 0;
  const hasArrived = previous.arrived || arrivalSamples >= config.arrivalConsecutiveSamples;

  // 3. Check off-route threshold (expanded by GPS accuracy so noisy urban fixes don't false-trigger)
  const effectiveOffRouteThreshold = Math.max(
    config.offRouteThresholdMeters,
    config.offRouteThresholdMeters + Math.min(60, (accuracyMeters ?? 0) * 0.75),
  );
  const offRouteSamples =
    !hasArrived && minCrossTrack > effectiveOffRouteThreshold ? previous.offRouteSamples + 1 : 0;
  const isOffRoute = offRouteSamples >= config.offRouteConsecutiveSamples;

  // 4. Advance active step when rider passes within stepAdvanceRadiusMeters of a maneuver
  let nextStepIdx = safeStepIdx;
  if (!hasArrived && !isOffRoute && nextStepIdx < route.steps.length - 1) {
    const distToManeuver = haversineDistanceMeters(
      position.latitude,
      position.longitude,
      currentStep.maneuverLocation.latitude,
      currentStep.maneuverLocation.longitude,
    );
    if (distToManeuver <= config.stepAdvanceRadiusMeters) {
      nextStepIdx += 1;
    }
  }

  const activeStep = route.steps[nextStepIdx]!;
  const distanceToNextTurnMeters = hasArrived
    ? 0
    : Math.round(
        haversineDistanceMeters(
          position.latitude,
          position.longitude,
          activeStep.maneuverLocation.latitude,
          activeStep.maneuverLocation.longitude,
        ),
      );

  const progressFraction =
    route.geometry.length > 1 ? Math.min(100, Math.round((closestSegIdx / (route.geometry.length - 1)) * 100)) : 0;

  const tracker: RouteTrackerState = {
    activeStepIndex: nextStepIdx,
    offRouteSamples,
    arrivalSamples,
    arrived: hasArrived,
    lastProgressPercent: progressFraction,
  };

  return {
    tracker,
    isProgressCurrent: true,
    isOffRoute,
    hasArrived,
    crossTrackDistanceMeters: Math.round(minCrossTrack),
    activeStep,
    distanceToNextTurnMeters,
    remainingDistanceMeters: hasArrived ? 0 : Math.round(distToDest),
    compactRoutePoints: compactRouteGeometry(route.geometry, closestSegIdx),
  };
}
