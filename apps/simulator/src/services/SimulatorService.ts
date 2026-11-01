import {
  PROTOCOL_VERSION,
  systemClock,
  type BLEStatus,
  type Clock,
  type GPSStatus,
  type NavigationData,
  type NavigationMode,
  type NavigationPacket,
  type RouteStatus,
  type TurnDirection,
} from "@w-map/navigation-core";
import { DEMO_ROUTE, positionAtProgress } from "../fixtures/demoRoute";
import type { NavigationDataProvider } from "./NavigationDataProvider";

/** How old the timestamp of a deliberately "stale" packet is (> default max packet age). */
export const STALE_PACKET_AGE_MS = 10_000;

/** Everything the control panel can change. */
export interface SimulatorControls {
  speedKmh: number;
  speedLimitKmh: number | null;
  limitFreshness: "FRESH" | "STALE";
  packetFreshness: "LIVE" | "STALE";
  mode: NavigationMode;
  turnDirection: TurnDirection;
  distanceToTurnMeters: number;
  gpsStatus: GPSStatus;
  bleStatus: BLEStatus;
  routeStatus: RouteStatus;
  routeAvailable: boolean;
  headingDegrees: number;
  /** 0..100: position along the demo route. */
  routeProgressPercent: number;
  autoSpeed: boolean;
}

export const DEFAULT_CONTROLS: SimulatorControls = {
  speedKmh: 45,
  speedLimitKmh: 50,
  limitFreshness: "FRESH",
  packetFreshness: "LIVE",
  mode: "TURN",
  turnDirection: "RIGHT",
  distanceToTurnMeters: 350,
  gpsStatus: "ACTIVE",
  bleStatus: "CONNECTED",
  routeStatus: "ACTIVE",
  routeAvailable: true,
  headingDegrees: 0,
  routeProgressPercent: 20,
  autoSpeed: false,
};

export interface SimulatorOptions {
  /** Injectable clock for deterministic tests. */
  clock?: Clock;
  /** Auto-speed timer period. */
  autoIntervalMs?: number;
  /** Periodic re-send so live data does not age. 0 disables (tests). */
  heartbeatMs?: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Simulated provider. Synthetic data only: no GPS, no Bluetooth.
 * Deterministic unless autoSpeed or heartbeat timers are enabled.
 */
export class SimulatorService implements NavigationDataProvider {
  readonly id = "simulator";
  readonly label = "SIMULATED data source";
  readonly isSimulated = true;

  private controls: SimulatorControls = { ...DEFAULT_CONTROLS };
  private sequence = 0;
  private phase = 0;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly dataListeners = new Set<(raw: string) => void>();
  private readonly controlListeners = new Set<() => void>();
  private readonly clock: Clock;
  private readonly autoIntervalMs: number;
  private readonly heartbeatMs: number;

  constructor(options: SimulatorOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.autoIntervalMs = options.autoIntervalMs ?? 500;
    this.heartbeatMs = options.heartbeatMs ?? 0;
  }

  // ---- NavigationDataProvider ----
  subscribe(listener: (rawMessage: string) => void): () => void {
    this.dataListeners.add(listener);
    if (this.heartbeatMs > 0 && this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => this.emitCurrent(), this.heartbeatMs);
    }
    listener(this.buildMessage());
    return () => {
      this.dataListeners.delete(listener);
      if (this.dataListeners.size === 0) this.stopHeartbeat();
    };
  }

  dispose(): void {
    this.stopAuto();
    this.stopHeartbeat();
    this.dataListeners.clear();
    this.controlListeners.clear();
  }

  // ---- Controls (useSyncExternalStore-compatible) ----
  getControls = (): SimulatorControls => this.controls;

  subscribeControls = (listener: () => void): (() => void) => {
    this.controlListeners.add(listener);
    return () => {
      this.controlListeners.delete(listener);
    };
  };

  /** Apply a partial update. Numbers are clamped; NaN is ignored. */
  update(patch: Partial<SimulatorControls>): void {
    const next: SimulatorControls = { ...this.controls, ...patch };
    const num = (key: "speedKmh" | "distanceToTurnMeters" | "headingDegrees" | "routeProgressPercent", min: number, max: number) => {
      const v = patch[key];
      if (v !== undefined) next[key] = Number.isFinite(v) ? clamp(Math.round(v), min, max) : this.controls[key];
    };
    num("speedKmh", 0, 160);
    num("distanceToTurnMeters", 0, 2000);
    num("headingDegrees", 0, 359);
    num("routeProgressPercent", 0, 100);
    this.controls = next;
    if (next.autoSpeed) this.startAuto();
    else this.stopAuto();
    this.controlListeners.forEach((l) => l());
    this.emitCurrent();
  }

  /** Restore the default test scenario. Sequence numbers keep increasing. */
  reset(): void {
    this.phase = 0;
    this.update({ ...DEFAULT_CONTROLS });
  }

  /** Advance the automatic speed profile by dtMs (public so tests can drive it). */
  tick(dtMs: number): void {
    this.phase += (dtMs / 8000) * 2 * Math.PI;
    this.update({ speedKmh: Math.round(70 + 60 * Math.sin(this.phase)) }); // 10..130 km/h
  }

  /** Re-send the current state with a new sequence number (what the heartbeat timer does). */
  emitCurrent(): void {
    const msg = this.buildMessage();
    this.dataListeners.forEach((l) => l(msg));
  }

  /** Test/diagnostic hook: push an arbitrary raw message through the same path. */
  emitRaw(raw: string): void {
    this.dataListeners.forEach((l) => l(raw));
  }

  // ---- internals ----
  private startAuto(): void {
    if (this.autoTimer !== null) return;
    this.autoTimer = setInterval(() => this.tick(this.autoIntervalMs), this.autoIntervalMs);
  }

  private stopAuto(): void {
    if (this.autoTimer === null) return;
    clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private buildData(): NavigationData {
    const c = this.controls;
    this.sequence += 1;
    const pos = positionAtProgress(c.routeProgressPercent);
    const navActive = c.routeStatus === "ACTIVE";
    return {
      sequenceNumber: this.sequence,
      timestamp: this.clock.nowMs() - (c.packetFreshness === "STALE" ? STALE_PACKET_AGE_MS : 0),
      currentSpeedKmh: c.speedKmh,
      speedLimitKmh: c.speedLimitKmh,
      turnDirection: c.turnDirection,
      distanceToTurnMeters: navActive ? c.distanceToTurnMeters : null,
      latitude: pos.latitude, // when GPS is LOST this is the last known position
      longitude: pos.longitude,
      headingDegrees: c.headingDegrees,
      gpsStatus: c.gpsStatus,
      bleStatus: c.bleStatus,
      routeStatus: c.routeStatus,
      speedLimitStatus: c.speedLimitKmh === null ? "UNKNOWN" : c.limitFreshness === "STALE" ? "STALE" : "VALID",
      routePoints: navActive && c.routeAvailable ? [...DEMO_ROUTE] : [],
    };
  }

  private buildMessage(): string {
    const packet: NavigationPacket = { version: PROTOCOL_VERSION, data: this.buildData() };
    return JSON.stringify(packet);
  }
}
