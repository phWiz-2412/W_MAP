import {
  PROTOCOL_VERSION,
  interpolateRoutePosition,
  parseRouteFixtureJson,
  resolveStepAtProgress,
  systemClock,
  validateRouteFixture,
  type BackdropRoad,
  type BLEStatus,
  type CalculatedRoute,
  type Clock,
  type GPSStatus,
  type NavigationData,
  type NavigationMode,
  type NavigationPacket,
  type RouteFixture,
  type RoutePoint,
  type RouteProgressEvaluation,
  type RouteStatus,
  type TurnDirection,
  type ValidationResult,
} from "@w-map/navigation-core";
import { DEMO_BACKDROP, DEMO_ROUTE, positionAtProgress } from "../fixtures/demoRoute";
import { DEFAULT_VN_FIXTURE } from "../fixtures/vnFixtures";
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
  /** 0..100: position along the route. */
  routeProgressPercent: number;
  autoSpeed: boolean;
  /** Currently loaded synthetic fixture ID. */
  activeFixtureId: string;
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
  activeFixtureId: DEFAULT_VN_FIXTURE.id,
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
  private activeFixture: RouteFixture | null = null;
  private calculatedRoute: CalculatedRoute | null = null;
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

  getActiveFixture(): RouteFixture | null {
    return this.activeFixture;
  }

  getBackdropRoads(): readonly BackdropRoad[] {
    return this.activeFixture?.backdropRoads ?? DEMO_BACKDROP;
  }

  /**
   * Apply or clear a calculated destination route from the DestinationNavigationPanel.
   * Speed limits from routing providers remain UNKNOWN unless explicitly overridden by simulator controls.
   */
  setCalculatedRoute(route: CalculatedRoute | null, evalResult?: RouteProgressEvaluation): void {
    this.calculatedRoute = route;
    if (!route || !evalResult) {
      this.emitCurrent();
      return;
    }
    this.controls = {
      ...this.controls,
      routeStatus: "ACTIVE",
      routeAvailable: evalResult.compactRoutePoints.length >= 2,
      turnDirection: evalResult.activeStep.turnDirection,
      distanceToTurnMeters: Math.min(2000, Math.max(0, Math.round(evalResult.distanceToNextTurnMeters))),
      ...(evalResult.activeStep.headingDegrees !== null ? { headingDegrees: evalResult.activeStep.headingDegrees } : {}),
      speedLimitKmh: evalResult.activeStep.speedLimitKmh,
      limitFreshness: evalResult.activeStep.speedLimitStatus === "STALE" ? "STALE" : "FRESH",
    };
    this.controlListeners.forEach((l) => l());
    this.emitCurrent();
  }

  /**
   * Load and apply a validated synthetic route fixture.
   * Rejects invalid fixtures without altering current simulator state.
   */
  loadFixture(input: unknown): ValidationResult<RouteFixture> {
    const validated = validateRouteFixture(input);
    if (!validated.ok) return validated;
    const f = validated.value;
    this.activeFixture = f;
    const step = resolveStepAtProgress(f.steps, f.initialState.progressPercent);
    this.update({
      activeFixtureId: f.id,
      speedKmh: f.initialState.currentSpeedKmh ?? 0,
      speedLimitKmh: step.speedLimitKmh,
      limitFreshness: step.speedLimitStatus === "STALE" ? "STALE" : "FRESH",
      packetFreshness: f.initialState.timestampAgeMs > 0 ? "STALE" : "LIVE",
      turnDirection: step.turnDirection,
      distanceToTurnMeters: step.distanceToTurnMeters ?? 0,
      headingDegrees: step.headingDegrees ?? 0,
      gpsStatus: f.initialState.gpsStatus,
      bleStatus: f.initialState.bleStatus,
      routeStatus: f.initialState.routeStatus,
      routeAvailable: f.routePoints.length >= 2,
      routeProgressPercent: f.initialState.progressPercent,
    });
    return validated;
  }

  /** Parse and load a route fixture from a raw JSON string. */
  loadFixtureJson(rawJson: string): ValidationResult<RouteFixture> {
    const parsed = parseRouteFixtureJson(rawJson);
    if (!parsed.ok) return parsed;
    return this.loadFixture(parsed.value);
  }

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

    // If a multi-step fixture is active and only routeProgressPercent was changed by the user,
    // update maneuver, distance, heading, and speed limit from the active fixture step.
    if (
      this.activeFixture &&
      patch.routeProgressPercent !== undefined &&
      patch.turnDirection === undefined &&
      patch.distanceToTurnMeters === undefined &&
      patch.headingDegrees === undefined &&
      patch.speedLimitKmh === undefined
    ) {
      const step = resolveStepAtProgress(this.activeFixture.steps, next.routeProgressPercent);
      next.turnDirection = step.turnDirection;
      if (step.distanceToTurnMeters !== null) {
        next.distanceToTurnMeters = clamp(Math.round(step.distanceToTurnMeters), 0, 2000);
      }
      if (step.headingDegrees !== null) {
        next.headingDegrees = clamp(Math.round(step.headingDegrees), 0, 359);
      }
      next.speedLimitKmh = step.speedLimitKmh;
      next.limitFreshness = step.speedLimitStatus === "STALE" ? "STALE" : "FRESH";
    }

    this.controls = next;
    if (next.autoSpeed) this.startAuto();
    else this.stopAuto();
    this.controlListeners.forEach((l) => l());
    this.emitCurrent();
  }

  /** Restore the default test scenario. Sequence numbers keep increasing. */
  reset(): void {
    this.phase = 0;
    this.activeFixture = null;
    this.calculatedRoute = null;
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

  private resolvePositionAndRoute(): { pos: RoutePoint | null; routePoints: RoutePoint[] } {
    const c = this.controls;
    const navActive = c.routeStatus === "ACTIVE";
    if (this.calculatedRoute) {
      const r = this.calculatedRoute;
      const pos = interpolateRoutePosition(r.geometry, c.routeProgressPercent, r.origin);
      const pts = navActive && c.routeAvailable ? [...r.geometry].slice(0, 64) : [];
      return { pos, routePoints: pts };
    }
    if (this.activeFixture) {
      const f = this.activeFixture;
      const pos = interpolateRoutePosition(f.routePoints, c.routeProgressPercent, f.initialState.fallbackPosition);
      const pts = navActive && c.routeAvailable ? [...f.routePoints] : [];
      return { pos, routePoints: pts };
    }
    return {
      pos: positionAtProgress(c.routeProgressPercent),
      routePoints: navActive && c.routeAvailable ? [...DEMO_ROUTE] : [],
    };
  }

  private buildData(): NavigationData {
    const c = this.controls;
    this.sequence += 1;
    const { pos, routePoints } = this.resolvePositionAndRoute();
    const navActive = c.routeStatus === "ACTIVE";
    return {
      sequenceNumber: this.sequence,
      timestamp: this.clock.nowMs() - (c.packetFreshness === "STALE" ? STALE_PACKET_AGE_MS : 0),
      currentSpeedKmh: c.speedKmh,
      speedLimitKmh: c.speedLimitKmh,
      turnDirection: c.turnDirection,
      distanceToTurnMeters: navActive ? c.distanceToTurnMeters : null,
      latitude: pos ? pos.latitude : null, // when GPS is LOST this is the last known position
      longitude: pos ? pos.longitude : null,
      headingDegrees: c.headingDegrees,
      gpsStatus: c.gpsStatus,
      bleStatus: c.bleStatus,
      routeStatus: c.routeStatus,
      speedLimitStatus: c.speedLimitKmh === null ? "UNKNOWN" : c.limitFreshness === "STALE" ? "STALE" : "VALID",
      routePoints,
    };
  }

  private buildMessage(): string {
    const packet: NavigationPacket = { version: PROTOCOL_VERSION, data: this.buildData() };
    return JSON.stringify(packet);
  }
}
