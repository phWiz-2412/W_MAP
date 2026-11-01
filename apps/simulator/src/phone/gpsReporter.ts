import {
  bearingDegrees,
  haversineDistanceMeters,
  type GpsFixMessage,
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

export interface GpsMessageBuildOptions {
  sampleTimestampMs?: number | null;
  phoneReceivedAtMs?: number | null;
  phoneSentAtMs?: number | null;
  phoneSessionId?: string | null;
  phoneSeq?: number | null;
  previousSample?: PositionSampleLike | null;
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

  let speedMps = validNativeSpeed;
  let headingDegrees = validNativeHeading;
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
