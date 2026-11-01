import type { NavigationData } from "../domain/types";
import type { ValidationResult } from "../validation/validateNavigation";

/** A real GPS fix reported by the phone (message type "gps"). Speed is in m/s as delivered by the platform. */
export interface GpsFixMessage {
  type: "gps";
  latitude: number;
  longitude: number;
  /** m/s, null when the platform has no speed. */
  speedMps: number | null;
  headingDegrees: number | null;
  accuracyMeters: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateGpsFix(input: unknown): ValidationResult<GpsFixMessage> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["gps message must be an object"] };
  }
  const m = input as Record<string, unknown>;
  const errors: string[] = [];
  if (m.type !== "gps") errors.push('type must be "gps"');
  if (!isNum(m.latitude) || m.latitude < -90 || m.latitude > 90) errors.push("latitude invalid");
  if (!isNum(m.longitude) || m.longitude < -180 || m.longitude > 180) errors.push("longitude invalid");
  // Platforms report "unknown" as null (or -1 on some); anything else must be a sane number.
  const speed = m.speedMps === undefined ? null : m.speedMps;
  if (speed !== null && !isNum(speed)) errors.push("speedMps must be a number or null");
  const heading = m.headingDegrees === undefined ? null : m.headingDegrees;
  if (heading !== null && !isNum(heading)) errors.push("headingDegrees must be a number or null");
  const acc = m.accuracyMeters === undefined ? null : m.accuracyMeters;
  if (acc !== null && !(isNum(acc) && acc >= 0)) errors.push("accuracyMeters must be >= 0 or null");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: "gps",
      latitude: m.latitude as number,
      longitude: m.longitude as number,
      speedMps: speed as number | null,
      headingDegrees: heading as number | null,
      accuracyMeters: acc as number | null,
    },
  };
}

export interface LiveGpsState {
  fix: GpsFixMessage | null;
  /** Receiver-side time the last fix arrived (avoids trusting the phone's clock). */
  fixReceivedAtMs: number | null;
  /** True when the transport to the phone is up and a phone is present. */
  linkConnected: boolean;
}

export interface LiveGpsConfig {
  /** No fix for longer than this => GPS LOST. */
  gpsTimeoutMs: number;
  /** Fixes less accurate than this are not trusted => GPS LOST. */
  maxAccuracyMeters: number;
}

export const DEFAULT_LIVE_GPS_CONFIG: LiveGpsConfig = { gpsTimeoutMs: 3000, maxAccuracyMeters: 100 };

/** m/s -> whole km/h. Negative, non-finite or implausible (>300 km/h) values become null. */
export function mpsToKmh(mps: number | null): number | null {
  if (mps === null || !Number.isFinite(mps) || mps < 0) return null;
  const kmh = Math.round(mps * 3.6);
  return kmh > 300 ? null : kmh;
}

/**
 * Builds a NavigationData from REAL GPS data only. It has no routing or speed-limit source,
 * so navigation is INACTIVE and the speed limit is UNKNOWN (null) - nothing is invented.
 */
export function buildLiveNavigationData(
  state: LiveGpsState,
  nowMs: number,
  sequenceNumber: number,
  config: LiveGpsConfig = DEFAULT_LIVE_GPS_CONFIG,
): NavigationData {
  const { fix, fixReceivedAtMs } = state;
  const fresh =
    fix !== null &&
    fixReceivedAtMs !== null &&
    nowMs - fixReceivedAtMs <= config.gpsTimeoutMs &&
    (fix.accuracyMeters === null || fix.accuracyMeters <= config.maxAccuracyMeters);
  const heading = fix?.headingDegrees;
  return {
    sequenceNumber,
    timestamp: nowMs,
    currentSpeedKmh: fix ? mpsToKmh(fix.speedMps) : null,
    speedLimitKmh: null,
    turnDirection: "STRAIGHT",
    distanceToTurnMeters: null,
    latitude: fix ? fix.latitude : null, // last known position when GPS is LOST
    longitude: fix ? fix.longitude : null,
    headingDegrees: heading !== null && heading !== undefined && heading >= 0 && heading < 360 ? heading : null,
    gpsStatus: fresh ? "ACTIVE" : "LOST",
    bleStatus: state.linkConnected ? "CONNECTED" : "DISCONNECTED",
    routeStatus: "INACTIVE",
    speedLimitStatus: "UNKNOWN",
    routePoints: [],
  };
}
