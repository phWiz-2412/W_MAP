import {
  bearingDegrees,
  haversineDistanceMeters,
  type GpsFixMessage,
  type NavigationMode,
  type RoutePoint,
  type RouteStatus,
  type TurnDirection,
} from "@w-map/navigation-core";

/** The subset of the browser GeolocationCoordinates we use (also easy to fake in tests). */
export interface CoordsLike {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  accuracy: number;
}

export interface PositionSampleLike {
  coords: CoordsLike;
  timestamp: number;
}

export type CompassSource = "webkit_compass" | "absolute_alpha" | "gps_course" | "derived" | "none";

/** Subset of browser DeviceOrientationEvent (including iOS Safari webkitCompassHeading). */
export interface DeviceOrientationLike {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number | null;
  webkitCompassAccuracy?: number | null;
}

export interface CompassReading {
  headingDegrees: number;
  accuracyDegrees: number | null;
  source: "webkit_compass" | "absolute_alpha";
}

/** Normalize any angle in degrees into `[0, 360)`. */
export function normalizeHeadingDegrees(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped === 360 ? 0 : Number(wrapped.toFixed(1));
}

/**
 * Shortest signed angular difference `(target - current)` in `[-180, 180)` degrees.
 */
export function shortestAngleDeltaDegrees(currentDeg: number, targetDeg: number): number {
  return ((((targetDeg - currentDeg) % 360) + 540) % 360) - 180;
}

/**
 * Circular low-pass filter for compass headings so transitions across `359° <-> 0°`
 * interpolate smoothly through North (`0°`) without wrap-around jumps.
 */
export function smoothCompassHeading(
  previousDeg: number | null,
  sampleDeg: number,
  smoothingFactor = 0.35,
): number {
  if (!Number.isFinite(sampleDeg)) return previousDeg ?? 0;
  const normalizedSample = normalizeHeadingDegrees(sampleDeg);
  if (previousDeg === null || !Number.isFinite(previousDeg)) {
    return normalizedSample;
  }
  const alpha = Math.max(0.05, Math.min(1, smoothingFactor));
  const delta = shortestAngleDeltaDegrees(previousDeg, normalizedSample);
  // Ignore sub-degree magnetometer micro-jitter (< 0.4 deg)
  if (Math.abs(delta) < 0.4) {
    return normalizeHeadingDegrees(previousDeg);
  }
  return normalizeHeadingDegrees(previousDeg + delta * alpha);
}

/**
 * Extract a real magnetic/true-north compass heading from a browser `DeviceOrientationEvent`.
 * - Prioritizes iOS Safari `webkitCompassHeading` (hardware magnetometer + gyroscope fusion).
 * - Rejects uncalibrated iOS readings (`webkitCompassAccuracy < 0`).
 * - Falls back to W3C `deviceorientationabsolute` (`absolute === true` with finite `alpha`),
 *   where compass heading clockwise from North is `(360 - alpha) % 360`.
 * - Never fabricates a heading from non-absolute relative `alpha`.
 */
export function extractCompassHeadingFromEvent(ev: DeviceOrientationLike | null | undefined): CompassReading | null {
  if (!ev || typeof ev !== "object") return null;

  if (typeof ev.webkitCompassHeading === "number" && Number.isFinite(ev.webkitCompassHeading)) {
    const acc =
      typeof ev.webkitCompassAccuracy === "number" && Number.isFinite(ev.webkitCompassAccuracy)
        ? ev.webkitCompassAccuracy
        : null;
    // On iOS CoreLocation, negative webkitCompassAccuracy (-1) indicates an uncalibrated/invalid compass
    if (acc !== null && acc < 0) {
      return null;
    }
    if (ev.webkitCompassHeading >= 0 && ev.webkitCompassHeading <= 360) {
      return {
        headingDegrees: normalizeHeadingDegrees(ev.webkitCompassHeading),
        accuracyDegrees: acc,
        source: "webkit_compass",
      };
    }
  }

  if (ev.absolute === true && typeof ev.alpha === "number" && Number.isFinite(ev.alpha)) {
    return {
      headingDegrees: normalizeHeadingDegrees(360 - ev.alpha),
      accuracyDegrees: null,
      source: "absolute_alpha",
    };
  }

  return null;
}

export interface GpsMessageBuildOptions {
  sampleTimestampMs?: number | null;
  phoneReceivedAtMs?: number | null;
  phoneSentAtMs?: number | null;
  phoneSessionId?: string | null;
  phoneSeq?: number | null;
  previousSample?: PositionSampleLike | null;
  /** Latest real hardware compass heading (0..360) from iPhone magnetometer/gyroscope, if available. */
  compassHeadingDegrees?: number | null;
  turnDirection?: TurnDirection;
  distanceToTurnMeters?: number | null;
  routeStatus?: RouteStatus;
  routePoints?: RoutePoint[];
  destinationName?: string | null;
  instruction?: string | null;
  remainingDistanceMeters?: number | null;
  displayMode?: NavigationMode;
}

const finiteOrNull = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null);

/**
 * Derive speed (m/s) and heading (deg) from two consecutive GPS samples when CoreLocation
 * returns `coords.speed === null` (e.g. during low-speed urban starts on iOS Safari).
 *
 * Safeguards against GPS noise:
 * - Elapsed time `dtMs` must be in `[400, 10000]` ms.
 * - Both fixes must have `accuracy <= 35` m.
 * - If horizontal displacement is less than `max(1.5, 0.35 * avgAccuracy)` meters, reports `0 m/s` (stationary).
 */
export function deriveSpeedAndHeadingFromSamples(
  prev: PositionSampleLike,
  curr: PositionSampleLike,
): { speedMps: number | null; headingDegrees: number | null } {
  const dtMs = curr.timestamp - prev.timestamp;
  if (!Number.isFinite(dtMs) || dtMs < 400 || dtMs > 10_000) {
    return { speedMps: null, headingDegrees: null };
  }
  const accPrev = prev.coords.accuracy;
  const accCurr = curr.coords.accuracy;
  if (!Number.isFinite(accPrev) || !Number.isFinite(accCurr) || accPrev > 35 || accCurr > 35) {
    return { speedMps: null, headingDegrees: null };
  }
  const distMeters = haversineDistanceMeters(
    prev.coords.latitude,
    prev.coords.longitude,
    curr.coords.latitude,
    curr.coords.longitude,
  );
  const noiseFloorMeters = Math.max(1.5, 0.25 * ((accPrev + accCurr) / 2));
  if (distMeters < noiseFloorMeters) {
    return { speedMps: 0, headingDegrees: null };
  }
  const speedMps = distMeters / (dtMs / 1000);
  if (speedMps > 83.33) {
    // > 300 km/h is implausible
    return { speedMps: null, headingDegrees: null };
  }
  const headingDegrees = bearingDegrees(
    prev.coords.latitude,
    prev.coords.longitude,
    curr.coords.latitude,
    curr.coords.longitude,
  );
  return { speedMps, headingDegrees };
}

/** Converts a browser position into the wire message. Platform "unknown" values become null (or derived when previousSample is provided). */
export function coordsToGpsMessage(c: CoordsLike, options: GpsMessageBuildOptions = {}): GpsFixMessage {
  const nativeSpeed = finiteOrNull(c.speed);
  const validNativeSpeed = nativeSpeed !== null && nativeSpeed >= 0 ? nativeSpeed : null;
  const nativeHeading = finiteOrNull(c.heading);
  const validNativeHeading =
    nativeHeading !== null && nativeHeading >= 0 && nativeHeading < 360 ? nativeHeading : null;
  const validCompassHeading =
    options.compassHeadingDegrees !== undefined &&
    options.compassHeadingDegrees !== null &&
    Number.isFinite(options.compassHeadingDegrees) &&
    options.compassHeadingDegrees >= 0 &&
    options.compassHeadingDegrees < 360
      ? normalizeHeadingDegrees(options.compassHeadingDegrees)
      : null;

  let speedMps = validNativeSpeed;
  // Use real hardware compass heading whenever stationary/slow (< 3 m/s) or when GPS course is unavailable;
  // when moving at speed (>= 3 m/s) with a valid GPS course, prefer GPS course-over-ground (or hardware compass if GPS course is null).
  let headingDegrees =
    validNativeSpeed !== null && validNativeSpeed >= 3.0 && validNativeHeading !== null
      ? validNativeHeading
      : (validCompassHeading ?? validNativeHeading);
  let speedSource: "native" | "derived" | "none" = validNativeSpeed !== null ? "native" : "none";

  if (
    speedMps === null &&
    options.previousSample &&
    options.sampleTimestampMs !== undefined &&
    options.sampleTimestampMs !== null
  ) {
    const derived = deriveSpeedAndHeadingFromSamples(options.previousSample, {
      coords: c,
      timestamp: options.sampleTimestampMs,
    });
    if (derived.speedMps !== null) {
      speedMps = derived.speedMps;
      speedSource = "derived";
      if (headingDegrees === null && derived.headingDegrees !== null) {
        headingDegrees = derived.headingDegrees;
      }
    }
  }

  const msg: GpsFixMessage = {
    type: "gps",
    latitude: c.latitude,
    longitude: c.longitude,
    speedMps,
    headingDegrees,
    accuracyMeters: Number.isFinite(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null,
  };

  if (options.sampleTimestampMs !== undefined) msg.sampleTimestampMs = options.sampleTimestampMs;
  if (options.phoneReceivedAtMs !== undefined) msg.phoneReceivedAtMs = options.phoneReceivedAtMs;
  if (options.phoneSentAtMs !== undefined) msg.phoneSentAtMs = options.phoneSentAtMs;
  if (options.phoneSessionId !== undefined) msg.phoneSessionId = options.phoneSessionId;
  if (options.phoneSeq !== undefined) msg.phoneSeq = options.phoneSeq;
  if (options.sampleTimestampMs !== undefined || options.previousSample !== undefined) {
    msg.speedSource = speedSource;
  }
  if (options.turnDirection !== undefined) msg.turnDirection = options.turnDirection;
  if (options.distanceToTurnMeters !== undefined) msg.distanceToTurnMeters = options.distanceToTurnMeters;
  if (options.routeStatus !== undefined) msg.routeStatus = options.routeStatus;
  if (options.routePoints !== undefined) msg.routePoints = options.routePoints;
  if (options.destinationName !== undefined) msg.destinationName = options.destinationName;
  if (options.instruction !== undefined) msg.instruction = options.instruction;
  if (options.remainingDistanceMeters !== undefined) {
    msg.remainingDistanceMeters = options.remainingDistanceMeters;
  }
  if (options.displayMode !== undefined) msg.displayMode = options.displayMode;

  return msg;
}

/** Recommended Geolocation PositionOptions for live motorcycle tracking on iOS Safari. */
export const LIVE_WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 6_000,
};

/** Human-readable explanation of a geolocation error code (1 denied, 2 unavailable, 3 timeout). */
export function describeGeoError(code: number): string {
  switch (code) {
    case 1:
      return "Location permission denied. Allow location for this site in iPhone Settings > Privacy > Location Services > Safari Websites.";
    case 2:
      return "Position unavailable (no GPS fix yet).";
    case 3:
      return "Timed out waiting for a GPS fix.";
    default:
      return "Unknown location error.";
  }
}
