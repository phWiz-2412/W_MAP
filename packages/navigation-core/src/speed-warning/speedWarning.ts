import type { NavigationData } from "../domain/types";

/**
 * Display state of the speed readout. Priority (highest first):
 * DISCONNECTED > GPS_LOST > DATA_STALE > NO_SPEED > UNKNOWN_LIMIT > STALE_LIMIT > WARNING / NORMAL.
 * Any state above NO_SPEED means the numbers cannot be trusted as live.
 */
export type SpeedState =
  | "NORMAL"
  | "WARNING"
  | "UNKNOWN_LIMIT"
  | "STALE_LIMIT"
  | "DATA_STALE"
  | "GPS_LOST"
  | "DISCONNECTED"
  | "NO_SPEED";

export interface WarningConfig {
  /** Warn when speed > limit + thresholdKmh. */
  thresholdKmh: number;
  /** Warning clears only when speed <= limit + thresholdKmh - hysteresisKmh. */
  hysteresisKmh: number;
  /** Speed must stay above the on-level this long before warning starts. */
  persistenceMs: number;
  /** Packets older than this are DATA_STALE. */
  maxPacketAgeMs: number;
}

export const DEFAULT_WARNING_CONFIG: WarningConfig = {
  thresholdKmh: 5,
  hysteresisKmh: 3,
  persistenceMs: 800,
  maxPacketAgeMs: 3000,
};

export interface WarningTracker {
  warning: boolean;
  /** Time (ms) when speed first exceeded the on-level, or null. */
  overSinceMs: number | null;
}

export const INITIAL_TRACKER: WarningTracker = { warning: false, overSinceMs: null };

export interface SpeedEvaluation {
  state: SpeedState;
  tracker: WarningTracker;
}

export type SpeedInput = Pick<
  NavigationData,
  "currentSpeedKmh" | "speedLimitKmh" | "speedLimitStatus" | "gpsStatus" | "bleStatus"
> & {
  /** now - packet timestamp, in ms. Negative values (clock skew) are treated as 0. */
  packetAgeMs: number;
};

/**
 * Pure speed-warning evaluation. Time is passed in (nowMs), so it is deterministic.
 * An unknown or stale limit never produces a warning and is never treated as 0.
 */
export function evaluateSpeed(
  input: SpeedInput,
  config: WarningConfig,
  previous: WarningTracker,
  nowMs: number,
): SpeedEvaluation {
  const reset = (state: SpeedState): SpeedEvaluation => ({ state, tracker: INITIAL_TRACKER });

  if (input.bleStatus === "DISCONNECTED") return reset("DISCONNECTED");
  if (input.gpsStatus === "LOST") return reset("GPS_LOST");
  if (Math.max(0, input.packetAgeMs) > config.maxPacketAgeMs) return reset("DATA_STALE");
  if (input.currentSpeedKmh === null) return reset("NO_SPEED");
  if (input.speedLimitKmh === null || input.speedLimitStatus === "UNKNOWN") return reset("UNKNOWN_LIMIT");
  if (input.speedLimitStatus === "STALE") return reset("STALE_LIMIT");

  const onLevel = input.speedLimitKmh + config.thresholdKmh;
  const offLevel = onLevel - config.hysteresisKmh;
  const speed = input.currentSpeedKmh;

  if (previous.warning) {
    return speed <= offLevel ? reset("NORMAL") : { state: "WARNING", tracker: previous };
  }
  if (speed > onLevel) {
    const overSinceMs = previous.overSinceMs ?? nowMs;
    if (nowMs - overSinceMs >= config.persistenceMs) {
      return { state: "WARNING", tracker: { warning: true, overSinceMs } };
    }
    return { state: "NORMAL", tracker: { warning: false, overSinceMs } };
  }
  return reset("NORMAL");
}

/** ms until a pending warning should be re-evaluated, or null if nothing is pending. */
export function pendingDelayMs(tracker: WarningTracker, config: WarningConfig, nowMs: number): number | null {
  if (tracker.warning || tracker.overSinceMs === null) return null;
  return Math.max(0, tracker.overSinceMs + config.persistenceMs - nowMs);
}
