import {
  MAX_DISTANCE_METERS,
  MAX_SPEED_KMH,
  MAX_SPEED_LIMIT_KMH,
  PROTOCOL_VERSION,
  TURN_DIRECTIONS,
  type GPSStatus,
  type NavigationData,
  type RoutePoint,
  type RouteStatus,
  type SpeedLimitStatus,
  type TurnDirection,
  type ValidationResult,
} from "../index";

/**
 * Project-defined BLE GATT Service and Characteristic UUIDs for W_MAP v1.
 * ESP32-S3 acts as the GATT Peripheral (Server); iPhone acts as the GATT Central (Client).
 */
export const WMAP_BLE_SERVICE_UUID = "7f3a0000-0000-4d41-5057-4d4150000001";
export const WMAP_BLE_TELEMETRY_CHAR_UUID = "7f3a0001-0000-4d41-5057-4d4150000001";
export const WMAP_BLE_ROUTE_CHUNK_CHAR_UUID = "7f3a0002-0000-4d41-5057-4d4150000001";
export const WMAP_BLE_DEVICE_STATUS_CHAR_UUID = "7f3a0003-0000-4d41-5057-4d4150000001";

export const WMAP_BLE_TELEMETRY_FRAME_BYTES = 38;
export const WMAP_BLE_DEVICE_STATUS_FRAME_BYTES = 16;
export const WMAP_BLE_ROUTE_CHUNK_HEADER_BYTES = 8;
export const WMAP_BLE_MAX_POINTS_PER_CHUNK = 20; // 8 + 20*8 = 168 bytes (fits within 185-byte ATT MTU)

export const BLE_MSG_TYPE_TELEMETRY = 0x01;
export const BLE_MSG_TYPE_ROUTE_CHUNK = 0x02;
export const BLE_MSG_TYPE_DEVICE_STATUS = 0x03;

export const BLE_U8_UNKNOWN = 0xff;
export const BLE_U16_UNKNOWN = 0xffff;
export const BLE_U32_UNKNOWN = 0xffffffff;
export const BLE_I32_UNKNOWN = -2147483648; // INT32_MIN (0x80000000)
export const MAX_REMAINING_DISTANCE_METERS = 1_000_000;

export interface BleTelemetryFrame {
  version: number;
  msgType: typeof BLE_MSG_TYPE_TELEMETRY;
  /** Non-zero session identifier (1..65535) generated when navigation starts or reconnects. */
  sessionId: number;
  /** Monotonically increasing sequence number (0..65535) within `sessionId`. */
  sequenceNumber: number;
  /** Sender monotonic timestamp (low 32 bits, milliseconds). */
  timestampMs: number;
  gpsStatus: GPSStatus;
  routeStatus: RouteStatus;
  speedLimitStatus: SpeedLimitStatus;
  isOffRoute: boolean;
  hasArrived: boolean;
  turnDirection: TurnDirection;
  currentSpeedKmh: number | null;
  speedLimitKmh: number | null;
  gpsAccuracyMeters: number | null;
  distanceToTurnMeters: number | null;
  remainingDistanceMeters: number | null;
  etaDurationMinutes: number | null;
  headingDegrees: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface BleDeviceStatusFrame {
  version: number;
  msgType: typeof BLE_MSG_TYPE_DEVICE_STATUS;
  lastSessionId: number;
  lastAcceptedSequence: number;
  lastPhoneTimestampMs: number;
  deviceUptimeMs: number;
  rxErrorCount: number;
}

export interface BleRouteChunkFrame {
  version: number;
  msgType: typeof BLE_MSG_TYPE_ROUTE_CHUNK;
  routeIdHash: number;
  chunkIndex: number;
  totalChunks: number;
  points: RoutePoint[];
}

/**
 * CRC-16/CCITT-FALSE (poly=0x1021, init=0xFFFF, xorOut=0x0000).
 * Used at the end of every binary BLE frame to detect bit/truncation corruption.
 */
export function crc16Ccitt(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= (bytes[i]! & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeSpeedLimitStatusBits(status: SpeedLimitStatus): number {
  if (status === "VALID") return 1;
  if (status === "STALE") return 2;
  return 0;
}

function decodeSpeedLimitStatusBits(bits: number): SpeedLimitStatus | null {
  if (bits === 0) return "UNKNOWN";
  if (bits === 1) return "VALID";
  if (bits === 2) return "STALE";
  return null;
}

/**
 * Encode a `BleTelemetryFrame` into a deterministic 38-byte Little-Endian binary payload.
 */
export function encodeBleTelemetryFrame(frame: BleTelemetryFrame): Uint8Array {
  if (frame.version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported BLE protocol version: ${frame.version}`);
  }
  if (!Number.isInteger(frame.sessionId) || frame.sessionId < 1 || frame.sessionId > 0xffff) {
    throw new Error("sessionId must be an integer in 1..65535");
  }
  if (!Number.isInteger(frame.sequenceNumber) || frame.sequenceNumber < 0 || frame.sequenceNumber > 0xffff) {
    throw new Error("sequenceNumber must be an integer in 0..65535");
  }
  if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) {
    throw new Error("timestampMs must be a non-negative finite number");
  }

  const turnIdx = TURN_DIRECTIONS.indexOf(frame.turnDirection);
  if (turnIdx < 0) {
    throw new Error(`Invalid turnDirection: ${String(frame.turnDirection)}`);
  }

  if (frame.speedLimitStatus === "UNKNOWN" && frame.speedLimitKmh !== null) {
    throw new Error("UNKNOWN speedLimitStatus requires speedLimitKmh === null");
  }
  if (
    frame.speedLimitStatus !== "UNKNOWN" &&
    (frame.speedLimitKmh === null || frame.speedLimitKmh <= 0 || frame.speedLimitKmh > MAX_SPEED_LIMIT_KMH)
  ) {
    throw new Error("VALID/STALE speedLimitStatus requires speedLimitKmh in 1..200");
  }

  const buf = new ArrayBuffer(WMAP_BLE_TELEMETRY_FRAME_BYTES);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let flags = 0;
  if (frame.gpsStatus === "ACTIVE") flags |= 1 << 0;
  if (frame.routeStatus === "ACTIVE") flags |= 1 << 1;
  flags |= (encodeSpeedLimitStatusBits(frame.speedLimitStatus) & 0x03) << 2;
  if (frame.isOffRoute) flags |= 1 << 4;
  if (frame.hasArrived) flags |= 1 << 5;

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, BLE_MSG_TYPE_TELEMETRY);
  view.setUint16(2, frame.sessionId & 0xffff, true);
  view.setUint16(4, frame.sequenceNumber & 0xffff, true);
  view.setUint32(6, Math.floor(frame.timestampMs) >>> 0, true);
  view.setUint8(10, flags);
  view.setUint8(11, turnIdx);

  // Speed (km/h): 0..300 or 0xFFFF for null
  if (frame.currentSpeedKmh === null) {
    view.setUint16(12, BLE_U16_UNKNOWN, true);
  } else {
    const spd = Math.round(frame.currentSpeedKmh);
    if (!Number.isFinite(spd) || spd < 0 || spd > MAX_SPEED_KMH) {
      throw new Error(`currentSpeedKmh out of range: ${frame.currentSpeedKmh}`);
    }
    view.setUint16(12, spd, true);
  }

  // Speed limit (km/h): 1..200 or 0 for UNKNOWN
  if (frame.speedLimitKmh === null) {
    view.setUint8(14, 0);
  } else {
    view.setUint8(14, Math.round(frame.speedLimitKmh));
  }

  // GPS accuracy (m): 0..254 or 0xFF for null
  if (frame.gpsAccuracyMeters === null) {
    view.setUint8(15, BLE_U8_UNKNOWN);
  } else {
    const acc = Math.max(0, Math.min(254, Math.round(frame.gpsAccuracyMeters)));
    view.setUint8(15, acc);
  }

  // Distance to next turn (m): 0..100000 or 0xFFFFFFFF for null
  if (frame.distanceToTurnMeters === null) {
    view.setUint32(16, BLE_U32_UNKNOWN, true);
  } else {
    const dist = Math.round(frame.distanceToTurnMeters);
    if (!Number.isFinite(dist) || dist < 0 || dist > MAX_DISTANCE_METERS) {
      throw new Error(`distanceToTurnMeters out of range: ${frame.distanceToTurnMeters}`);
    }
    view.setUint32(16, dist >>> 0, true);
  }

  // Remaining route distance (m): 0..1000000 or 0xFFFFFFFF for null
  if (frame.remainingDistanceMeters === null) {
    view.setUint32(20, BLE_U32_UNKNOWN, true);
  } else {
    const rem = Math.round(frame.remainingDistanceMeters);
    if (!Number.isFinite(rem) || rem < 0 || rem > MAX_REMAINING_DISTANCE_METERS) {
      throw new Error(`remainingDistanceMeters out of range: ${frame.remainingDistanceMeters}`);
    }
    view.setUint32(20, rem >>> 0, true);
  }

  // ETA duration (minutes): 0..65534 or 0xFFFF for null
  if (frame.etaDurationMinutes === null) {
    view.setUint16(24, BLE_U16_UNKNOWN, true);
  } else {
    const eta = Math.max(0, Math.min(65534, Math.round(frame.etaDurationMinutes)));
    view.setUint16(24, eta, true);
  }

  // Heading (0.1 degree units, 0..3599) or 0xFFFF for null
  if (frame.headingDegrees === null) {
    view.setUint16(26, BLE_U16_UNKNOWN, true);
  } else {
    if (!Number.isFinite(frame.headingDegrees) || frame.headingDegrees < 0 || frame.headingDegrees >= 360) {
      throw new Error(`headingDegrees out of range: ${frame.headingDegrees}`);
    }
    const deci = Math.round(frame.headingDegrees * 10) % 3600;
    view.setUint16(26, deci, true);
  }

  // Coordinates (latE6, lonE6) or INT32_MIN for null
  if (frame.latitude === null || frame.longitude === null) {
    if (frame.latitude !== null || frame.longitude !== null) {
      throw new Error("latitude and longitude must both be null or both be finite numbers");
    }
    view.setInt32(28, BLE_I32_UNKNOWN, true);
    view.setInt32(32, BLE_I32_UNKNOWN, true);
  } else {
    if (
      !Number.isFinite(frame.latitude) ||
      !Number.isFinite(frame.longitude) ||
      frame.latitude < -90 ||
      frame.latitude > 90 ||
      frame.longitude < -180 ||
      frame.longitude > 180
    ) {
      throw new Error("latitude/longitude out of valid geographic range");
    }
    view.setInt32(28, Math.round(frame.latitude * 1e6), true);
    view.setInt32(32, Math.round(frame.longitude * 1e6), true);
  }

  const crc = crc16Ccitt(bytes, 0, 36);
  view.setUint16(36, crc, true);
  return bytes;
}

/**
 * Decode and strictly validate a 38-byte binary BLE telemetry payload.
 */
export function decodeBleTelemetryFrame(bytes: Uint8Array): ValidationResult<BleTelemetryFrame> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== WMAP_BLE_TELEMETRY_FRAME_BYTES) {
    return {
      ok: false,
      errors: [`Expected ${WMAP_BLE_TELEMETRY_FRAME_BYTES} bytes, got ${bytes?.byteLength ?? 0}`],
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expectedCrc = crc16Ccitt(bytes, 0, 36);
  const actualCrc = view.getUint16(36, true);
  if (expectedCrc !== actualCrc) {
    return {
      ok: false,
      errors: [`CRC-16 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`],
    };
  }

  const errors: string[] = [];
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    errors.push(`Unsupported BLE protocol version: ${version}`);
  }

  const msgType = view.getUint8(1);
  if (msgType !== BLE_MSG_TYPE_TELEMETRY) {
    errors.push(`Unexpected message type: 0x${msgType.toString(16)}`);
  }

  const sessionId = view.getUint16(2, true);
  if (sessionId === 0) {
    errors.push("sessionId must be non-zero (1..65535)");
  }

  const sequenceNumber = view.getUint16(4, true);
  const timestampMs = view.getUint32(6, true);
  const flags = view.getUint8(10);
  if ((flags & 0xc0) !== 0) {
    errors.push("Reserved flag bits 6..7 must be zero");
  }

  const gpsStatus: GPSStatus = (flags & (1 << 0)) !== 0 ? "ACTIVE" : "LOST";
  const routeStatus: RouteStatus = (flags & (1 << 1)) !== 0 ? "ACTIVE" : "INACTIVE";
  const speedLimitStatus = decodeSpeedLimitStatusBits((flags >> 2) & 0x03);
  if (!speedLimitStatus) {
    errors.push("Invalid speedLimitStatus bits in flags");
  }
  const isOffRoute = (flags & (1 << 4)) !== 0;
  const hasArrived = (flags & (1 << 5)) !== 0;

  const turnIdx = view.getUint8(11);
  const turnDirection = TURN_DIRECTIONS[turnIdx];
  if (!turnDirection) {
    errors.push(`Invalid turnDirection enum index: ${turnIdx}`);
  }

  const rawSpeed = view.getUint16(12, true);
  let currentSpeedKmh: number | null = null;
  if (rawSpeed !== BLE_U16_UNKNOWN) {
    if (rawSpeed > MAX_SPEED_KMH) {
      errors.push(`currentSpeedKmh exceeds max (${rawSpeed} > ${MAX_SPEED_KMH})`);
    } else {
      currentSpeedKmh = rawSpeed;
    }
  }

  const rawLimit = view.getUint8(14);
  let speedLimitKmh: number | null = null;
  if (rawLimit !== 0) {
    if (rawLimit > MAX_SPEED_LIMIT_KMH) {
      errors.push(`speedLimitKmh exceeds max (${rawLimit} > ${MAX_SPEED_LIMIT_KMH})`);
    } else {
      speedLimitKmh = rawLimit;
    }
  }

  if (speedLimitStatus === "UNKNOWN" && speedLimitKmh !== null) {
    errors.push("UNKNOWN speedLimitStatus requires speedLimitKmh === 0 (null)");
  }
  if ((speedLimitStatus === "VALID" || speedLimitStatus === "STALE") && speedLimitKmh === null) {
    errors.push(`${speedLimitStatus} speedLimitStatus requires non-zero speedLimitKmh`);
  }

  const rawAcc = view.getUint8(15);
  const gpsAccuracyMeters = rawAcc === BLE_U8_UNKNOWN ? null : rawAcc;

  const rawDistTurn = view.getUint32(16, true);
  let distanceToTurnMeters: number | null = null;
  if (rawDistTurn !== BLE_U32_UNKNOWN) {
    if (rawDistTurn > MAX_DISTANCE_METERS) {
      errors.push(`distanceToTurnMeters exceeds max (${rawDistTurn} > ${MAX_DISTANCE_METERS})`);
    } else {
      distanceToTurnMeters = rawDistTurn;
    }
  }

  const rawRemDist = view.getUint32(20, true);
  let remainingDistanceMeters: number | null = null;
  if (rawRemDist !== BLE_U32_UNKNOWN) {
    if (rawRemDist > MAX_REMAINING_DISTANCE_METERS) {
      errors.push(`remainingDistanceMeters exceeds max (${rawRemDist} > ${MAX_REMAINING_DISTANCE_METERS})`);
    } else {
      remainingDistanceMeters = rawRemDist;
    }
  }

  const rawEta = view.getUint16(24, true);
  const etaDurationMinutes = rawEta === BLE_U16_UNKNOWN ? null : rawEta;

  const rawHeading = view.getUint16(26, true);
  let headingDegrees: number | null = null;
  if (rawHeading !== BLE_U16_UNKNOWN) {
    if (rawHeading >= 3600) {
      errors.push(`headingDeciDeg out of range (${rawHeading} >= 3600)`);
    } else {
      headingDegrees = Number((rawHeading / 10).toFixed(1));
    }
  }

  const rawLat = view.getInt32(28, true);
  const rawLon = view.getInt32(32, true);
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (rawLat === BLE_I32_UNKNOWN && rawLon === BLE_I32_UNKNOWN) {
    latitude = null;
    longitude = null;
  } else if (rawLat === BLE_I32_UNKNOWN || rawLon === BLE_I32_UNKNOWN) {
    errors.push("latitude and longitude must both be present or both be INT32_MIN");
  } else {
    const lat = rawLat / 1e6;
    const lon = rawLon / 1e6;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Coordinate out of range: (${lat}, ${lon})`);
    } else {
      latitude = Number(lat.toFixed(6));
      longitude = Number(lon.toFixed(6));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      version,
      msgType: BLE_MSG_TYPE_TELEMETRY,
      sessionId,
      sequenceNumber,
      timestampMs,
      gpsStatus,
      routeStatus,
      speedLimitStatus: speedLimitStatus!,
      isOffRoute,
      hasArrived,
      turnDirection: turnDirection!,
      currentSpeedKmh,
      speedLimitKmh,
      gpsAccuracyMeters,
      distanceToTurnMeters,
      remainingDistanceMeters,
      etaDurationMinutes,
      headingDegrees,
      latitude,
      longitude,
    },
  };
}

/**
 * Encode a Device Status / Acknowledgement frame sent from ESP32-S3 to iPhone (16 bytes).
 */
export function encodeBleDeviceStatus(status: BleDeviceStatusFrame): Uint8Array {
  const buf = new ArrayBuffer(WMAP_BLE_DEVICE_STATUS_FRAME_BYTES);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, BLE_MSG_TYPE_DEVICE_STATUS);
  view.setUint16(2, status.lastSessionId & 0xffff, true);
  view.setUint16(4, status.lastAcceptedSequence & 0xffff, true);
  view.setUint32(6, Math.floor(status.lastPhoneTimestampMs) >>> 0, true);
  view.setUint32(10, Math.floor(status.deviceUptimeMs) >>> 0, true);
  view.setUint16(14, crc16Ccitt(bytes, 0, 14), true);
  return bytes;
}

export function decodeBleDeviceStatus(bytes: Uint8Array): ValidationResult<BleDeviceStatusFrame> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== WMAP_BLE_DEVICE_STATUS_FRAME_BYTES) {
    return { ok: false, errors: ["Invalid device status frame length"] };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const crc = crc16Ccitt(bytes, 0, 14);
  if (crc !== view.getUint16(14, true)) {
    return { ok: false, errors: ["Device status CRC-16 mismatch"] };
  }
  const version = view.getUint8(0);
  const msgType = view.getUint8(1);
  if (version !== PROTOCOL_VERSION || msgType !== BLE_MSG_TYPE_DEVICE_STATUS) {
    return { ok: false, errors: ["Invalid device status header"] };
  }
  return {
    ok: true,
    value: {
      version,
      msgType: BLE_MSG_TYPE_DEVICE_STATUS,
      lastSessionId: view.getUint16(2, true),
      lastAcceptedSequence: view.getUint16(4, true),
      lastPhoneTimestampMs: view.getUint32(6, true),
      deviceUptimeMs: view.getUint32(10, true),
      rxErrorCount: 0,
    },
  };
}

/**
 * Latest-state BLE transmission policy:
 * - Suppresses redundant frames when meaningful state (maneuver, speed, route status, GPS status,
 *   distance change >= 3 m) has not changed AND `heartbeatIntervalMs` has not elapsed.
 * - Holds at most ONE pending replaceable telemetry frame when the BLE GATT write channel is busy,
 *   preventing unbounded queues or stale backlog transmission.
 */
export class BleLatestStateTxQueue {
  private lastSentFrame: BleTelemetryFrame | null = null;
  private lastSentAtMs: number | null = null;
  private pendingFrame: BleTelemetryFrame | null = null;
  private channelBusy = false;
  public coalescedDrops = 0;
  public redundantSkips = 0;
  public sentCount = 0;

  constructor(private readonly heartbeatIntervalMs = 1000) {}

  shouldTransmit(candidate: BleTelemetryFrame, nowMs: number): boolean {
    const prev = this.lastSentFrame;
    if (!prev || this.lastSentAtMs === null) return true;
    if (nowMs - this.lastSentAtMs >= this.heartbeatIntervalMs) return true;
    if (
      prev.sessionId !== candidate.sessionId ||
      prev.gpsStatus !== candidate.gpsStatus ||
      prev.routeStatus !== candidate.routeStatus ||
      prev.turnDirection !== candidate.turnDirection ||
      prev.speedLimitStatus !== candidate.speedLimitStatus ||
      prev.speedLimitKmh !== candidate.speedLimitKmh ||
      prev.isOffRoute !== candidate.isOffRoute ||
      prev.hasArrived !== candidate.hasArrived ||
      prev.currentSpeedKmh !== candidate.currentSpeedKmh
    ) {
      return true;
    }
    if (prev.distanceToTurnMeters !== candidate.distanceToTurnMeters) {
      if (prev.distanceToTurnMeters === null || candidate.distanceToTurnMeters === null) return true;
      if (Math.abs(prev.distanceToTurnMeters - candidate.distanceToTurnMeters) >= 3) return true;
    }
    return false;
  }

  enqueue(candidate: BleTelemetryFrame, nowMs: number): Uint8Array | null {
    if (!this.shouldTransmit(candidate, nowMs)) {
      this.redundantSkips += 1;
      return null;
    }
    if (this.channelBusy) {
      if (this.pendingFrame !== null) {
        this.coalescedDrops += 1;
      }
      this.pendingFrame = candidate;
      return null;
    }
    this.lastSentFrame = candidate;
    this.lastSentAtMs = nowMs;
    this.sentCount += 1;
    return encodeBleTelemetryFrame(candidate);
  }

  setChannelBusy(busy: boolean): void {
    this.channelBusy = busy;
  }

  flushPending(nowMs: number): Uint8Array | null {
    if (this.channelBusy || !this.pendingFrame) return null;
    const next = this.pendingFrame;
    this.pendingFrame = null;
    this.lastSentFrame = next;
    this.lastSentAtMs = nowMs;
    this.sentCount += 1;
    return encodeBleTelemetryFrame(next);
  }
}

export interface BleReceiverSnapshot {
  connected: boolean;
  isStale: boolean;
  activeSessionId: number | null;
  lastSequenceNumber: number | null;
  lastFrameReceivedAtMs: number | null;
  lastFrame: BleTelemetryFrame | null;
  navigationData: NavigationData | null;
  acceptedFrames: number;
  rejectedFrames: number;
  duplicateOrOldFrames: number;
  sessionResets: number;
  lastError: string | null;
}

/**
 * Deterministic ESP32-S3 / Display receiver state machine:
 * - Validates binary frames and CRC-16.
 * - Tracks `sessionId` and monotonic `sequenceNumber` within the session.
 * - Evaluates receiver-side freshness (`maxFrameAgeMs`, default 3000 ms) so a stalled sender
 *   or lost BLE link is never presented as current data.
 */
export class BleReceiverStateMachine {
  private connected = false;
  private activeSessionId: number | null = null;
  private lastSequenceNumber: number | null = null;
  private lastFrameReceivedAtMs: number | null = null;
  private lastFrame: BleTelemetryFrame | null = null;
  private routeGeometry: RoutePoint[] = [];
  private acceptedFrames = 0;
  private rejectedFrames = 0;
  private duplicateOrOldFrames = 0;
  private sessionResets = 0;
  private lastError: string | null = null;

  constructor(private readonly maxFrameAgeMs = 3000) {}

  onConnect(): void {
    this.connected = true;
  }

  onDisconnect(): void {
    this.connected = false;
    this.activeSessionId = null;
    this.lastSequenceNumber = null;
  }

  setRouteGeometry(points: RoutePoint[]): void {
    this.routeGeometry = points.slice(0, 64);
  }

  receiveTelemetryBytes(bytes: Uint8Array, receivedAtMs: number): ValidationResult<BleTelemetryFrame> {
    this.connected = true;
    const decoded = decodeBleTelemetryFrame(bytes);
    if (!decoded.ok) {
      this.rejectedFrames += 1;
      this.lastError = decoded.errors.join("; ");
      return decoded;
    }

    const frame = decoded.value;
    if (this.activeSessionId === null) {
      this.activeSessionId = frame.sessionId;
      this.lastSequenceNumber = null;
    } else if (frame.sessionId !== this.activeSessionId) {
      this.activeSessionId = frame.sessionId;
      this.lastSequenceNumber = null;
      this.sessionResets += 1;
    }

    if (this.lastSequenceNumber !== null && frame.sequenceNumber <= this.lastSequenceNumber) {
      this.duplicateOrOldFrames += 1;
      this.lastError = `Duplicate or older sequenceNumber (${frame.sequenceNumber} <= ${this.lastSequenceNumber})`;
      return { ok: false, errors: [this.lastError] };
    }

    this.lastSequenceNumber = frame.sequenceNumber;
    this.lastFrameReceivedAtMs = receivedAtMs;
    this.lastFrame = frame;
    this.acceptedFrames += 1;
    this.lastError = null;
    return { ok: true, value: frame };
  }

  getSnapshot(nowMs: number): BleReceiverSnapshot {
    const isStale =
      this.lastFrameReceivedAtMs === null || nowMs - this.lastFrameReceivedAtMs > this.maxFrameAgeMs;

    const navigationData: NavigationData | null = this.lastFrame
      ? {
          sequenceNumber: this.lastFrame.sequenceNumber,
          // Receiver stamps effective timestamp so `evaluateSpeed` detects stale BLE feed deterministically
          timestamp: this.lastFrameReceivedAtMs ?? 0,
          currentSpeedKmh: this.connected && !isStale ? this.lastFrame.currentSpeedKmh : null,
          speedLimitKmh: this.lastFrame.speedLimitKmh,
          turnDirection: this.lastFrame.turnDirection,
          distanceToTurnMeters: this.lastFrame.distanceToTurnMeters,
          latitude: this.lastFrame.latitude,
          longitude: this.lastFrame.longitude,
          headingDegrees: this.lastFrame.headingDegrees,
          gpsStatus: this.lastFrame.gpsStatus,
          bleStatus: this.connected ? "CONNECTED" : "DISCONNECTED",
          routeStatus: this.lastFrame.routeStatus,
          speedLimitStatus: this.lastFrame.speedLimitStatus,
          routePoints: this.routeGeometry,
        }
      : null;

    return {
      connected: this.connected,
      isStale,
      activeSessionId: this.activeSessionId,
      lastSequenceNumber: this.lastSequenceNumber,
      lastFrameReceivedAtMs: this.lastFrameReceivedAtMs,
      lastFrame: this.lastFrame,
      navigationData,
      acceptedFrames: this.acceptedFrames,
      rejectedFrames: this.rejectedFrames,
      duplicateOrOldFrames: this.duplicateOrOldFrames,
      sessionResets: this.sessionResets,
      lastError: this.lastError,
    };
  }
}

/**
 * Golden BLE v1 Telemetry Test Vectors shared across TypeScript, ESP32-S3 C++ firmware, and iOS Swift.
 */
export interface BleGoldenVector {
  name: string;
  frame: BleTelemetryFrame;
  expectedHex: string;
}

export const BLE_GOLDEN_VECTORS: readonly BleGoldenVector[] = [
  {
    name: "Active navigation in Da Nang (Turn Right in 180m, 45 km/h, limit UNKNOWN)",
    frame: {
      version: 1,
      msgType: BLE_MSG_TYPE_TELEMETRY,
      sessionId: 0x1024,
      sequenceNumber: 7,
      timestampMs: 125_000,
      gpsStatus: "ACTIVE",
      routeStatus: "ACTIVE",
      speedLimitStatus: "UNKNOWN",
      isOffRoute: false,
      hasArrived: false,
      turnDirection: "RIGHT",
      currentSpeedKmh: 45,
      speedLimitKmh: null,
      gpsAccuracyMeters: 6,
      distanceToTurnMeters: 180,
      remainingDistanceMeters: 8450,
      etaDurationMinutes: 14,
      headingDegrees: 92.5,
      latitude: 16.0611,
      longitude: 108.2272,
    },
    expectedHex: "01012410070048e8010003012d000006b4000000022100000e009d03ac12f500806a7306650d",
  },
  {
    name: "GPS lost & route inactive (all nullable fields set to explicit sentinel values)",
    frame: {
      version: 1,
      msgType: BLE_MSG_TYPE_TELEMETRY,
      sessionId: 0x1024,
      sequenceNumber: 8,
      timestampMs: 126_000,
      gpsStatus: "LOST",
      routeStatus: "INACTIVE",
      speedLimitStatus: "UNKNOWN",
      isOffRoute: false,
      hasArrived: false,
      turnDirection: "STRAIGHT",
      currentSpeedKmh: null,
      speedLimitKmh: null,
      gpsAccuracyMeters: null,
      distanceToTurnMeters: null,
      remainingDistanceMeters: null,
      etaDurationMinutes: null,
      headingDegrees: null,
      latitude: null,
      longitude: null,
    },
    expectedHex: "01012410080030ec01000002ffff00ffffffffffffffffffffffffff0000008000000080ba0a",
  },
];
