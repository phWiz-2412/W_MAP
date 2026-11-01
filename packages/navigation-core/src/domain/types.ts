/** Shared navigation data model. Framework-independent; used by UI, simulator, and (later) BLE layers. */

export const NAVIGATION_MODES = ["TURN", "MAP"] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const TURN_DIRECTIONS = ["LEFT", "RIGHT", "STRAIGHT", "U_TURN", "ROUNDABOUT"] as const;
export type TurnDirection = (typeof TURN_DIRECTIONS)[number];

export type GPSStatus = "ACTIVE" | "LOST";
export type BLEStatus = "CONNECTED" | "DISCONNECTED";
/** Whether turn-by-turn navigation is currently running (not whether geometry exists). */
export const ROUTE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];
/**
 * VALID   – known and current.
 * UNKNOWN – no verified limit available (speedLimitKmh must be null).
 * STALE   – a limit is known but may be outdated; never treated as verified.
 */
export type SpeedLimitStatus = "VALID" | "UNKNOWN" | "STALE";

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface NavigationData {
  sequenceNumber: number;
  /** Sender time, ms since epoch. Used to compute packet age at the receiver. */
  timestamp: number;
  currentSpeedKmh: number | null;
  /** null = unknown. Never a guessed value, never 0 for "unknown". */
  speedLimitKmh: number | null;
  turnDirection: TurnDirection;
  distanceToTurnMeters: number | null;
  latitude: number | null;
  longitude: number | null;
  /** 0 <= heading < 360, clockwise from north. */
  headingDegrees: number | null;
  gpsStatus: GPSStatus;
  bleStatus: BLEStatus;
  routeStatus: RouteStatus;
  speedLimitStatus: SpeedLimitStatus;
  /** Empty when no route geometry is available. */
  routePoints: RoutePoint[];
}

export const PROTOCOL_VERSION = 1;

/** Wire-level envelope (readable JSON form; a compact binary form is specified in docs/BLE_PROTOCOL.md). */
export interface NavigationPacket {
  version: typeof PROTOCOL_VERSION;
  data: NavigationData;
}

/** Injectable clock so time-dependent logic is deterministic in tests. */
export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/** Manually advanced clock for tests and fixtures. */
export class ManualClock implements Clock {
  private current: number;
  constructor(startMs = 0) {
    this.current = startMs;
  }
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
