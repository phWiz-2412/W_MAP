import {
  PROTOCOL_VERSION,
  TURN_DIRECTIONS,
  type NavigationData,
  type NavigationPacket,
  type RoutePoint,
  type TurnDirection,
} from "../domain/types";

export const MAX_SPEED_KMH = 300;
export const MAX_SPEED_LIMIT_KMH = 200;
export const MAX_DISTANCE_METERS = 100_000;
/** Cap keeps packets within a realistic BLE budget; see docs/BLE_PROTOCOL.md. */
export const MAX_ROUTE_POINTS = 64;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isOneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === "string" && (options as readonly string[]).includes(v);
const nullableInRange = (v: unknown, min: number, max: number): boolean =>
  v === null || (isNum(v) && v >= min && v <= max);

function validateRoutePoints(v: unknown, errors: string[]): RoutePoint[] {
  if (!Array.isArray(v)) {
    errors.push("routePoints must be an array");
    return [];
  }
  if (v.length > MAX_ROUTE_POINTS) {
    errors.push(`routePoints must contain at most ${MAX_ROUTE_POINTS} points`);
    return [];
  }
  const out: RoutePoint[] = [];
  v.forEach((p: unknown, i) => {
    const r = p as Record<string, unknown> | null;
    if (
      typeof r !== "object" ||
      r === null ||
      !isNum(r.latitude) ||
      !isNum(r.longitude) ||
      r.latitude < -90 ||
      r.latitude > 90 ||
      r.longitude < -180 ||
      r.longitude > 180
    ) {
      errors.push(`routePoints[${i}] has malformed coordinates`);
    } else {
      out.push({ latitude: r.latitude, longitude: r.longitude });
    }
  });
  return out;
}

/** Validate an untrusted value as NavigationData. */
export function validateNavigationData(input: unknown): ValidationResult<NavigationData> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["data must be an object"] };
  }
  const m = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNum(m.sequenceNumber) || !Number.isInteger(m.sequenceNumber) || m.sequenceNumber < 0) {
    errors.push("sequenceNumber must be a non-negative integer");
  }
  if (!isNum(m.timestamp) || m.timestamp < 0) errors.push("timestamp must be a non-negative finite number");
  if (!nullableInRange(m.currentSpeedKmh, 0, MAX_SPEED_KMH)) {
    errors.push(`currentSpeedKmh must be null or in 0..${MAX_SPEED_KMH}`);
  }
  if (m.speedLimitKmh !== null && !(isNum(m.speedLimitKmh) && m.speedLimitKmh > 0 && m.speedLimitKmh <= MAX_SPEED_LIMIT_KMH)) {
    errors.push(`speedLimitKmh must be null or in (0..${MAX_SPEED_LIMIT_KMH}]`);
  }
  if (!isOneOf(m.turnDirection, TURN_DIRECTIONS)) errors.push("turnDirection is invalid");
  if (!nullableInRange(m.distanceToTurnMeters, 0, MAX_DISTANCE_METERS)) {
    errors.push(`distanceToTurnMeters must be null or in 0..${MAX_DISTANCE_METERS}`);
  }
  if (!nullableInRange(m.latitude, -90, 90)) errors.push("latitude must be null or in -90..90");
  if (!nullableInRange(m.longitude, -180, 180)) errors.push("longitude must be null or in -180..180");
  if (m.headingDegrees !== null && !(isNum(m.headingDegrees) && m.headingDegrees >= 0 && m.headingDegrees < 360)) {
    errors.push("headingDegrees must be null or in [0, 360)");
  }
  if (!isOneOf(m.gpsStatus, ["ACTIVE", "LOST"] as const)) errors.push("gpsStatus is invalid");
  if (!isOneOf(m.bleStatus, ["CONNECTED", "DISCONNECTED"] as const)) errors.push("bleStatus is invalid");
  if (!isOneOf(m.routeStatus, ["ACTIVE", "INACTIVE"] as const)) errors.push("routeStatus is invalid");
  if (!isOneOf(m.speedLimitStatus, ["VALID", "UNKNOWN", "STALE"] as const)) errors.push("speedLimitStatus is invalid");
  const routePoints = validateRoutePoints(m.routePoints, errors);

  if (errors.length === 0) {
    if (m.speedLimitStatus === "UNKNOWN" && m.speedLimitKmh !== null) {
      errors.push("speedLimitStatus UNKNOWN requires speedLimitKmh null");
    }
    if (m.speedLimitStatus !== "UNKNOWN" && m.speedLimitKmh === null) {
      errors.push(`speedLimitStatus ${String(m.speedLimitStatus)} requires a speedLimitKmh value`);
    }
    if ((m.latitude === null) !== (m.longitude === null)) {
      errors.push("latitude and longitude must both be set or both be null");
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      sequenceNumber: m.sequenceNumber as number,
      timestamp: m.timestamp as number,
      currentSpeedKmh: m.currentSpeedKmh as number | null,
      speedLimitKmh: m.speedLimitKmh as number | null,
      turnDirection: m.turnDirection as TurnDirection,
      distanceToTurnMeters: m.distanceToTurnMeters as number | null,
      latitude: m.latitude as number | null,
      longitude: m.longitude as number | null,
      headingDegrees: m.headingDegrees as number | null,
      gpsStatus: m.gpsStatus as NavigationData["gpsStatus"],
      bleStatus: m.bleStatus as NavigationData["bleStatus"],
      routeStatus: m.routeStatus as NavigationData["routeStatus"],
      speedLimitStatus: m.speedLimitStatus as NavigationData["speedLimitStatus"],
      routePoints,
    },
  };
}

/** Validate the packet envelope (version + data). */
export function validateNavigationPacket(input: unknown): ValidationResult<NavigationPacket> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["packet must be an object"] };
  }
  const p = input as Record<string, unknown>;
  if (p.version !== PROTOCOL_VERSION) {
    return { ok: false, errors: [`unsupported packet version (expected ${PROTOCOL_VERSION})`] };
  }
  const data = validateNavigationData(p.data);
  if (!data.ok) return data;
  return { ok: true, value: { version: PROTOCOL_VERSION, data: data.value } };
}

/** Parse + validate a JSON packet. Never throws. */
export function parseNavigationPacketJson(raw: string): ValidationResult<NavigationPacket> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["packet is not valid JSON"] };
  }
  return validateNavigationPacket(parsed);
}

/** Accept only strictly increasing sequence numbers (drops duplicates and out-of-order packets). */
export function isNewerSequence(lastAccepted: number | null, candidate: number): boolean {
  return lastAccepted === null || candidate > lastAccepted;
}
