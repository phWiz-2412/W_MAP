import type { NavigationData } from "../domain/types";
import type { ValidationResult } from "../validation/validateNavigation";

/**
 * A real GPS fix reported by the phone (message type "gps").
 * Speed is in m/s as delivered by the platform (or computed via movement fallback when CoreLocation speed is null).
 *
 * Timing fields (optional so legacy minimal messages remain valid):
 * - `sampleTimestampMs`: GeolocationPosition.timestamp (phone clock, ms)
 * - `phoneReceivedAtMs`: Date.now() on phone when watchPosition callback fired
 * - `phoneSentAtMs`: Date.now() on phone immediately before WebSocket send
 * - `relayReceivedAtMs`: Date.now() on the PC relay server when the frame arrived (PC clock)
 * - `phoneSessionId` / `phoneSeq`: Sender session identifier and monotonic packet counter
 * - `speedSource`: `"native"` when reported by iOS Location Services, `"derived"` when calculated from consecutive fixes, `"none"` when unavailable
 */
export interface GpsFixMessage {
  type: "gps";
  latitude: number;
  longitude: number;
  /** m/s, null when no speed is available. */
  speedMps: number | null;
  headingDegrees: number | null;
  accuracyMeters: number | null;
  sampleTimestampMs?: number | null;
  phoneReceivedAtMs?: number | null;
  phoneSentAtMs?: number | null;
  relayReceivedAtMs?: number | null;
  phoneSessionId?: string | null;
  phoneSeq?: number | null;
  speedSource?: "native" | "derived" | "none";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isOptNonNegNum = (v: unknown): v is number | null | undefined =>
  v === undefined || v === null || (isNum(v) && v >= 0);

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

  if (!isOptNonNegNum(m.sampleTimestampMs)) errors.push("sampleTimestampMs must be >= 0 or null");
  if (!isOptNonNegNum(m.phoneReceivedAtMs)) errors.push("phoneReceivedAtMs must be >= 0 or null");
  if (!isOptNonNegNum(m.phoneSentAtMs)) errors.push("phoneSentAtMs must be >= 0 or null");
  if (!isOptNonNegNum(m.relayReceivedAtMs)) errors.push("relayReceivedAtMs must be >= 0 or null");
  if (m.phoneSessionId !== undefined && m.phoneSessionId !== null && typeof m.phoneSessionId !== "string") {
    errors.push("phoneSessionId must be a string or null");
  }
  if (
    m.phoneSeq !== undefined &&
    m.phoneSeq !== null &&
    !(isNum(m.phoneSeq) && Number.isInteger(m.phoneSeq) && m.phoneSeq >= 0)
  ) {
    errors.push("phoneSeq must be a non-negative integer or null");
  }
  if (
    m.speedSource !== undefined &&
    m.speedSource !== "native" &&
    m.speedSource !== "derived" &&
    m.speedSource !== "none"
  ) {
    errors.push('speedSource must be "native", "derived", or "none"');
  }

  if (errors.length > 0) return { ok: false, errors };

  const out: GpsFixMessage = {
    type: "gps",
    latitude: m.latitude as number,
    longitude: m.longitude as number,
    speedMps: speed as number | null,
    headingDegrees: heading as number | null,
    accuracyMeters: acc as number | null,
  };
  if (m.sampleTimestampMs !== undefined) out.sampleTimestampMs = m.sampleTimestampMs as number | null;
  if (m.phoneReceivedAtMs !== undefined) out.phoneReceivedAtMs = m.phoneReceivedAtMs as number | null;
  if (m.phoneSentAtMs !== undefined) out.phoneSentAtMs = m.phoneSentAtMs as number | null;
  if (m.relayReceivedAtMs !== undefined) out.relayReceivedAtMs = m.relayReceivedAtMs as number | null;
  if (m.phoneSessionId !== undefined) out.phoneSessionId = m.phoneSessionId as string | null;
  if (m.phoneSeq !== undefined) out.phoneSeq = m.phoneSeq as number | null;
  if (m.speedSource !== undefined) {
    out.speedSource = m.speedSource as "native" | "derived" | "none";
  }

  return { ok: true, value: out };
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

/**
 * Measurable latency and telemetry metrics for the live GPS pipeline.
 * Note on clock domains:
 * - `phoneSampleAgeMs` and `phoneProcessingDelayMs` are computed strictly within the phone's clock domain.
 * - `relayToSimulatorMs`, `simulatorProcessingMs`, and `timeSinceLastFixMs` are computed strictly within the PC's clock domain.
 * - `roundTripPingMs` is measured by a WebSocket ping echoed back to the sender (single clock domain).
 * Cross-device one-way network transit time (phone clock -> PC clock) is not subtracted directly because
 * unsynchronized wall clocks can differ by hundreds of milliseconds.
 */
export interface LiveLatencyMetrics {
  /** On-phone age of the GPS fix when received by JS: phoneReceivedAtMs - sampleTimestampMs (ms, phone clock). */
  phoneSampleAgeMs: number | null;
  /** On-phone JS processing delay before WebSocket send: phoneSentAtMs - phoneReceivedAtMs (ms, phone clock). */
  phoneProcessingDelayMs: number | null;
  /** Local PC transit from Vite WebSocket relay to simulator handler: simReceivedAtMs - relayReceivedAtMs (ms, PC clock). */
  relayToSimulatorMs: number | null;
  /** Simulator validation + state update duration (ms, PC clock). */
  simulatorProcessingMs: number | null;
  /** Time elapsed on PC since the last valid GPS fix arrived (ms, PC clock). */
  timeSinceLastFixMs: number | null;
  /** Time elapsed on PC since any relay message arrived (ms, PC clock). */
  timeSinceLastPacketMs: number | null;
  /** Measured WebSocket round-trip time (RTT) via echo ping (ms, single clock domain). */
  roundTripPingMs: number | null;
  /** Effective incoming GPS fix frequency (Hz) over a rolling window. */
  updateFrequencyHz: number;
  /** Total valid GPS fixes accepted in the current session. */
  acceptedFixes: number;
  /** Total malformed/invalid messages rejected. */
  invalidMessages: number;
  /** Total duplicate or out-of-order phone packets dropped. */
  droppedOutOfOrder: number;
  /** Speed source of the latest fix ("native" from CoreLocation, "derived" from Haversine fallback, or "none"). */
  speedSource: "native" | "derived" | "none";
}

/** m/s -> whole km/h. Negative, non-finite or implausible (>300 km/h) values become null. */
export function mpsToKmh(mps: number | null): number | null {
  if (mps === null || !Number.isFinite(mps) || mps < 0) return null;
  const kmh = Math.round(mps * 3.6);
  return kmh > 300 ? null : kmh;
}

/** Great-circle distance in meters between two WGS84 points (Haversine formula). */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial compass bearing in degrees [0, 360) from point 1 to point 2. */
export function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Builds a NavigationData from REAL GPS data only.
 * By default it has no routing or speed-limit source (`routeStatus: "INACTIVE"`, `speedLimitStatus: "UNKNOWN"`).
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
