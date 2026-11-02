import {
  INITIAL_ROUTE_TRACKER,
  compactRouteGeometry,
  evaluateRouteProgress,
  type CalculatedRoute,
  type NavigationMode,
  type RoutePoint,
  type RouteProgressEvaluation,
  type RouteStatus,
  type RouteTrackerState,
  type TurnDirection,
} from "@w-map/navigation-core";
import {
  LIVE_WATCH_OPTIONS,
  coordsToGpsMessage,
  describeGeoError,
  extractCompassHeadingFromEvent,
  shortestAngleDeltaDegrees,
  smoothCompassHeading,
  type CompassSource,
  type CoordsLike,
  type DeviceOrientationLike,
  type PositionSampleLike,
} from "./gpsReporter";
import {
  buildRelayWebSocketUrl,
  computeReconnectDelayMs,
  sanitizeRelayEndpoint,
} from "../services/LivePhoneProvider";

export type PhoneWsState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export type PhoneGpsState = "idle" | "permission_required" | "waiting_for_fix" | "active" | "error";

export interface PhoneSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface GeolocationLike {
  watchPosition(
    success: (pos: { coords: CoordsLike; timestamp: number }) => void,
    error?: (err: { code: number; message?: string }) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(watchId: number): void;
}

export interface PhoneClientSnapshot {
  running: boolean;
  wsState: PhoneWsState;
  gpsState: PhoneGpsState;
  statusLabel: string;
  linkLabel: string;
  infoLabel: string;
  errorMessage: string;
  speedKmhText: string;
  relayDisplays: number;
  fixesAcquired: number;
  packetsSent: number;
  packetsDeliveredToDisplay: number;
  lastSentAtMs: number | null;
  relayEndpoint: string;
  /** Latest real GPS coordinates on the phone, if available. */
  currentPosition: RoutePoint | null;
  /** Display mode ("TURN" | "MAP") controlled from the phone companion page. */
  displayMode: NavigationMode;
  /** Active route calculated on the phone ("Phone as Brain"). */
  activeRoute: CalculatedRoute | null;
  destinationName: string | null;
  activeInstruction: string | null;
  activeTurnDirection: TurnDirection;
  distanceToTurnMeters: number | null;
  remainingDistanceMeters: number | null;
  routeStatus: RouteStatus;
  /** Hardware magnetometer/gyroscope heading in [0, 360) degrees clockwise from North, or null when unavailable. */
  compassHeadingDegrees: number | null;
  compassAccuracyDegrees: number | null;
  compassSource: CompassSource;
  compassText: string;
}

export interface PhoneClientOptions {
  url?: string;
  location?: Pick<Location, "protocol" | "host">;
  geolocation?: GeolocationLike | null;
  socketFactory?: (url: string) => PhoneSocketLike;
  clock?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
  onChange?: (snapshot: PhoneClientSnapshot) => void;
  /** Invoked when 3 consecutive GPS fixes deviate >50m from the active route so the phone can reroute. */
  onAutoRerouteRequested?: (currentPosition: RoutePoint) => void;
}

const WS_OPEN = 1;

/**
 * Testable state machine for the phone GPS & Navigation Brain page (`phone.html`).
 * Strictly separates:
 * 1. WebSocket transport connection to the relay
 * 2. Authoritative PC display presence on the relay (`presence.displays`)
 * 3. Geolocation watcher lifecycle and local GPS fix acquisition
 * 4. Phone-side turn-by-turn route evaluation ("Phone as Brain" like SteedPilot)
 * 5. Actual WebSocket packet transmission (`packetsSent`) and display delivery (`packetsDeliveredToDisplay`)
 */
export class PhoneGpsClient {
  private watchId: number | null = null;
  private ws: PhoneSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private wsState: PhoneWsState = "idle";
  private gpsState: PhoneGpsState = "idle";
  private relayDisplays = 0;
  private sessionId = "";
  private phoneSeq = 0;
  private fixesAcquired = 0;
  private packetsSent = 0;
  private packetsDeliveredToDisplay = 0;
  private lastSentAtMs: number | null = null;
  private previousSample: PositionSampleLike | null = null;
  private latestPendingPayload: string | null = null;
  private speedKmhText = "--";
  private lastFixSummary = "";
  private errorMessage = "";

  // "Phone as Brain" route & display state
  private displayMode: NavigationMode = "TURN";
  private activeRoute: CalculatedRoute | null = null;
  private destinationName: string | null = null;
  private trackerState: RouteTrackerState = INITIAL_ROUTE_TRACKER;
  private latestEval: RouteProgressEvaluation | null = null;

  // Real hardware compass sensor state (iOS Safari webkitCompassHeading / W3C deviceorientationabsolute)
  private compassHeadingDegrees: number | null = null;
  private compassAccuracyDegrees: number | null = null;
  private compassSource: CompassSource = "none";
  private lastCompassSentAtMs = 0;
  private lastSentCompassDeg: number | null = null;
  private orientationListener: ((ev: Event) => void) | null = null;

  private readonly url: string;
  private readonly sanitizedEndpoint: string;
  private readonly geo: GeolocationLike | null;
  private readonly socketFactory: (url: string) => PhoneSocketLike;
  private readonly clock: () => number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
  private readonly onChange: ((snapshot: PhoneClientSnapshot) => void) | undefined;
  private readonly onAutoRerouteRequested: ((currentPosition: RoutePoint) => void) | undefined;

  constructor(options: PhoneClientOptions = {}) {
    const loc =
      options.location ??
      (typeof window !== "undefined" ? window.location : { protocol: "https:", host: "localhost:5173" });
    this.url = options.url ?? buildRelayWebSocketUrl(loc, "phone");
    this.sanitizedEndpoint = sanitizeRelayEndpoint(this.url);
    this.geo =
      options.geolocation !== undefined
        ? options.geolocation
        : typeof navigator !== "undefined" && "geolocation" in navigator
          ? (navigator.geolocation as unknown as GeolocationLike)
          : null;
    this.socketFactory = options.socketFactory ?? ((u) => new WebSocket(u) as unknown as PhoneSocketLike);
    this.clock = options.clock ?? (() => Date.now());
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
    this.random = options.random ?? Math.random;
    this.onChange = options.onChange;
    this.onAutoRerouteRequested = options.onAutoRerouteRequested;
  }

  start(): void {
    if (!this.geo) {
      this.gpsState = "error";
      this.errorMessage = "Geolocation is not supported by this browser.";
      this.notify();
      return;
    }

    // Clear any existing watcher so start() never leaks duplicate watchers
    this.clearWatcher();

    this.running = true;
    this.sessionId = `s-${this.clock().toString(36)}-${Math.floor(this.random() * 1e6).toString(36)}`;
    this.phoneSeq = 0;
    this.fixesAcquired = 0;
    this.packetsSent = 0;
    this.packetsDeliveredToDisplay = 0;
    this.lastSentAtMs = null;
    this.previousSample = null;
    this.latestPendingPayload = null;
    this.lastFixSummary = "";
    this.errorMessage = "";
    this.gpsState = "permission_required";
    this.reconnectAttempts = 0;

    this.connectSocket();
    this.attachCompassListeners();

    // Once watchPosition is registered without immediate synchronous denial, transition to waiting_for_fix
    let synchronousError = false;
    this.watchId = this.geo.watchPosition(
      (pos) => this.handlePosition(pos),
      (err) => {
        synchronousError = true;
        this.handleGeoError(err);
      },
      LIVE_WATCH_OPTIONS,
    );
    if (!synchronousError && this.gpsState === "permission_required") {
      this.gpsState = "waiting_for_fix";
    }
    this.notify();
  }

  stop(): void {
    this.running = false;
    this.clearWatcher();
    this.detachCompassListeners();
    this.clearReconnectTimer();
    this.detachAndCloseSocket();
    this.wsState = "idle";
    this.gpsState = "idle";
    this.relayDisplays = 0;
    this.previousSample = null;
    this.latestPendingPayload = null;
    this.speedKmhText = "--";
    this.lastFixSummary = "";
    this.notify();
  }

  /**
   * Requests iOS 13+ Safari `DeviceOrientationEvent.requestPermission()` when triggered from a user tap gesture,
   * and attaches real hardware magnetometer/gyroscope listeners (`deviceorientation` / `deviceorientationabsolute`).
   */
  async requestCompassPermission(): Promise<boolean> {
    if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      const doe = window.DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied" | string>;
      };
      if (typeof doe.requestPermission === "function") {
        try {
          const state = await doe.requestPermission();
          if (state !== "granted") {
            this.errorMessage = "Compass permission denied in Safari — allow Motion & Orientation access.";
            this.notify();
            return false;
          }
        } catch (err) {
          this.errorMessage =
            err instanceof Error ? err.message : "Failed to request Safari compass permission.";
          this.notify();
          return false;
        }
      }
    }
    this.attachCompassListeners();
    return true;
  }

  /**
   * Processes a real hardware `DeviceOrientationEvent` from iPhone Safari (`webkitCompassHeading`)
   * or W3C `deviceorientationabsolute`. Applies circular low-pass smoothing and streams real-time
   * `{ type: "compass" }` updates over the relay when the phone rotates (even at 0 km/h).
   */
  handleDeviceOrientation(ev: DeviceOrientationLike): void {
    const reading = extractCompassHeadingFromEvent(ev);
    if (!reading) return;

    this.compassHeadingDegrees = smoothCompassHeading(
      this.compassHeadingDegrees,
      reading.headingDegrees,
      0.35,
    );
    this.compassAccuracyDegrees = reading.accuracyDegrees;
    this.compassSource = reading.source;

    const now = this.clock();
    const roundedHeading = Number(this.compassHeadingDegrees.toFixed(1));
    const delta =
      this.lastSentCompassDeg === null
        ? 360
        : Math.abs(shortestAngleDeltaDegrees(this.lastSentCompassDeg, roundedHeading));

    if (
      this.running &&
      this.ws &&
      this.ws.readyState === WS_OPEN &&
      this.wsState === "connected" &&
      delta >= 1.0 &&
      now - this.lastCompassSentAtMs >= 100
    ) {
      this.lastCompassSentAtMs = now;
      this.lastSentCompassDeg = roundedHeading;
      try {
        this.ws.send(
          JSON.stringify({
            type: "compass",
            headingDegrees: roundedHeading,
            compassSource: this.compassSource,
            compassAccuracyDegrees: this.compassAccuracyDegrees,
            phoneSessionId: this.sessionId,
            phoneSentAtMs: now,
          }),
        );
      } catch {
        // Ignore transient compass send error
      }
    }
    this.notify();
  }

  private attachCompassListeners(): void {
    if (this.orientationListener || typeof window === "undefined") return;
    this.orientationListener = (ev: Event) => {
      this.handleDeviceOrientation(ev as unknown as DeviceOrientationLike);
    };
    window.addEventListener("deviceorientationabsolute", this.orientationListener, true);
    window.addEventListener("deviceorientation", this.orientationListener, true);
  }

  private detachCompassListeners(): void {
    if (!this.orientationListener || typeof window === "undefined") return;
    window.removeEventListener("deviceorientationabsolute", this.orientationListener, true);
    window.removeEventListener("deviceorientation", this.orientationListener, true);
    this.orientationListener = null;
  }

  private formatCompassText(): string {
    if (this.compassHeadingDegrees === null) {
      return "Compass: waiting for sensor / tap Enable Compass";
    }
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
    const deg = ((this.compassHeadingDegrees % 360) + 360) % 360;
    const cardinal = dirs[Math.round(deg / 45) % 8];
    const accPart =
      this.compassAccuracyDegrees !== null ? ` (±${Math.round(this.compassAccuracyDegrees)}°)` : "";
    const srcPart =
      this.compassSource === "webkit_compass"
        ? "iOS Magnetometer"
        : this.compassSource === "absolute_alpha"
          ? "Absolute Sensor"
          : "GPS Course";
    return `Compass: ${String(Math.round(deg)).padStart(3, "0")}° ${cardinal}${accPart} [${srcPart}]`;
  }

  /**
   * Set or clear the active route calculated on the phone ("Phone as Brain").
   * Immediately evaluates against the latest GPS position (if any) and transmits
   * updated guidance to the display over the relay.
   */
  setCalculatedRoute(route: CalculatedRoute | null, destinationName?: string | null): void {
    this.activeRoute = route;
    this.destinationName = route ? (destinationName ?? "Destination") : null;
    this.trackerState = INITIAL_ROUTE_TRACKER;
    if (route && this.previousSample) {
      this.latestEval = evaluateRouteProgress(
        route,
        {
          latitude: this.previousSample.coords.latitude,
          longitude: this.previousSample.coords.longitude,
        },
        this.previousSample.coords.accuracy,
        "ACTIVE",
        this.trackerState,
      );
      this.trackerState = this.latestEval.tracker;
    } else {
      this.latestEval = null;
    }
    this.sendGuidanceControlIfConnected();
    this.notify();
  }

  /** Switch the target display mode ("TURN" | "MAP") from the phone companion UI. */
  setDisplayMode(mode: NavigationMode): void {
    this.displayMode = mode;
    this.sendGuidanceControlIfConnected();
    this.notify();
  }

  getLatestPosition(): RoutePoint | null {
    if (!this.previousSample) return null;
    return {
      latitude: this.previousSample.coords.latitude,
      longitude: this.previousSample.coords.longitude,
    };
  }

  getSnapshot(): PhoneClientSnapshot {
    const statusLabel = this.computeStatusLabel();
    const linkLabel = this.computeLinkLabel();
    const infoLabel = this.computeInfoLabel();
    const g = this.resolveCurrentGuidanceFields();
    return {
      running: this.running,
      wsState: this.wsState,
      gpsState: this.gpsState,
      statusLabel,
      linkLabel,
      infoLabel,
      errorMessage: this.errorMessage,
      speedKmhText: this.speedKmhText,
      relayDisplays: this.relayDisplays,
      fixesAcquired: this.fixesAcquired,
      packetsSent: this.packetsSent,
      packetsDeliveredToDisplay: this.packetsDeliveredToDisplay,
      lastSentAtMs: this.lastSentAtMs,
      relayEndpoint: this.sanitizedEndpoint,
      currentPosition: this.getLatestPosition(),
      displayMode: this.displayMode,
      activeRoute: this.activeRoute,
      destinationName: g.destinationName,
      activeInstruction: g.instruction,
      activeTurnDirection: g.turnDirection,
      distanceToTurnMeters: g.distanceToTurnMeters,
      remainingDistanceMeters: g.remainingDistanceMeters,
      routeStatus: g.routeStatus,
      compassHeadingDegrees: this.compassHeadingDegrees,
      compassAccuracyDegrees: this.compassAccuracyDegrees,
      compassSource: this.compassSource,
      compassText: this.formatCompassText(),
    };
  }

  private resolveCurrentGuidanceFields(): {
    routeStatus: RouteStatus;
    turnDirection: TurnDirection;
    distanceToTurnMeters: number | null;
    routePoints: RoutePoint[];
    destinationName: string | null;
    instruction: string | null;
    remainingDistanceMeters: number | null;
  } {
    if (!this.activeRoute) {
      return {
        routeStatus: "INACTIVE",
        turnDirection: "STRAIGHT",
        distanceToTurnMeters: null,
        routePoints: [],
        destinationName: null,
        instruction: null,
        remainingDistanceMeters: null,
      };
    }
    if (this.latestEval) {
      return {
        routeStatus: "ACTIVE",
        turnDirection: this.latestEval.activeStep.turnDirection,
        distanceToTurnMeters: this.latestEval.distanceToNextTurnMeters,
        routePoints: this.latestEval.compactRoutePoints,
        destinationName: this.destinationName,
        instruction: this.latestEval.activeStep.instruction,
        remainingDistanceMeters: this.latestEval.remainingDistanceMeters,
      };
    }
    const firstStep = this.activeRoute.steps[0];
    return {
      routeStatus: "ACTIVE",
      turnDirection: firstStep?.turnDirection ?? "STRAIGHT",
      distanceToTurnMeters: firstStep ? Math.round(firstStep.distanceMeters) : null,
      routePoints: compactRouteGeometry(this.activeRoute.geometry, 0),
      destinationName: this.destinationName,
      instruction: firstStep?.instruction ?? null,
      remainingDistanceMeters: Math.round(this.activeRoute.totalDistanceMeters),
    };
  }

  private sendGuidanceControlIfConnected(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN || this.wsState !== "connected") return;
    const g = this.resolveCurrentGuidanceFields();
    try {
      this.ws.send(
        JSON.stringify({
          type: "phone_guidance",
          routeStatus: g.routeStatus,
          turnDirection: g.turnDirection,
          distanceToTurnMeters: g.distanceToTurnMeters,
          routePoints: g.routePoints,
          destinationName: g.destinationName,
          instruction: g.instruction,
          remainingDistanceMeters: g.remainingDistanceMeters,
          displayMode: this.displayMode,
        }),
      );
    } catch {
      // Ignore control send error
    }
  }

  private clearWatcher(): void {
    if (this.watchId !== null && this.geo) {
      this.geo.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detachAndCloseSocket(): void {
    const s = this.ws;
    this.ws = null;
    if (s) {
      s.onopen = null;
      s.onclose = null;
      s.onerror = null;
      s.onmessage = null;
      try {
        s.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  private connectSocket(): void {
    this.clearReconnectTimer();
    this.detachAndCloseSocket();

    this.wsState = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    this.relayDisplays = 0;
    this.notify();

    let socket: PhoneSocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch (err) {
      this.wsState = "error";
      this.errorMessage =
        err instanceof Error ? err.message : `Failed to open WebSocket to ${this.sanitizedEndpoint}`;
      this.notify();
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.wsState = "connected";
      this.reconnectAttempts = 0;
      if (this.errorMessage.startsWith("Relay WebSocket")) {
        this.errorMessage = "";
      }
      // Request fresh presence from relay on open
      try {
        socket.send(JSON.stringify({ type: "presence_request" }));
      } catch {
        // Ignore if control send fails
      }
      if (this.activeRoute) {
        this.sendGuidanceControlIfConnected();
      }
      // Flush single-slot latest pending GPS fix if one arrived while connecting
      if (this.latestPendingPayload !== null && socket.readyState === WS_OPEN) {
        const pending = this.latestPendingPayload;
        this.latestPendingPayload = null;
        this.trySendPayload(socket, pending);
      }
      this.notify();
    };

    socket.onmessage = (ev) => {
      if (this.ws !== socket) return;
      this.handleRelayMessage(ev.data);
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.relayDisplays = 0;
      if (!this.running) {
        this.wsState = "idle";
        this.notify();
        return;
      }
      const willReconnect = this.reconnectBaseMs > 0;
      this.wsState = willReconnect ? "reconnecting" : "disconnected";
      if (!this.errorMessage) {
        this.errorMessage = `Relay WebSocket disconnected (${this.sanitizedEndpoint}).`;
      }
      this.notify();
      if (willReconnect) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.wsState = "error";
      this.errorMessage = `Relay WebSocket connection failed (${this.sanitizedEndpoint}). Check that npm run dev:phone is running and PC/iPhone share the same HTTPS URL.`;
      this.notify();
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (!this.running || this.reconnectBaseMs <= 0) return;
    const delayMs = computeReconnectDelayMs(
      this.reconnectAttempts,
      this.reconnectBaseMs,
      this.reconnectMaxMs,
      this.random,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running && this.ws === null) {
        this.connectSocket();
      }
    }, delayMs);
  }

  private handleRelayMessage(raw: unknown): void {
    try {
      const parsed = JSON.parse(String(raw)) as {
        type?: unknown;
        displays?: unknown;
      } | null;
      if (parsed && parsed.type === "presence" && typeof parsed.displays === "number") {
        const prevDisplays = this.relayDisplays;
        this.relayDisplays = Math.max(0, Math.floor(parsed.displays));
        if (this.relayDisplays > prevDisplays && this.activeRoute) {
          this.sendGuidanceControlIfConnected();
        }
        this.notify();
      }
    } catch {
      // Ignore unrecognized frames
    }
  }

  private handlePosition(pos: { coords: CoordsLike; timestamp: number }): void {
    if (!this.running) return;
    const receivedAtMs = this.clock();
    this.fixesAcquired += 1;
    this.phoneSeq += 1;
    this.gpsState = "active";
    if (this.errorMessage && !this.errorMessage.startsWith("Relay WebSocket")) {
      this.errorMessage = "";
    }

    let routeGuidanceOpts: Partial<Parameters<typeof coordsToGpsMessage>[1]> = {};
    let triggerReroute = false;
    if (this.activeRoute) {
      const evalRes = evaluateRouteProgress(
        this.activeRoute,
        {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        },
        pos.coords.accuracy,
        "ACTIVE",
        this.trackerState,
      );
      this.trackerState = evalRes.tracker;
      this.latestEval = evalRes;
      routeGuidanceOpts = {
        routeStatus: "ACTIVE",
        turnDirection: evalRes.activeStep.turnDirection,
        distanceToTurnMeters: evalRes.distanceToNextTurnMeters,
        routePoints: evalRes.compactRoutePoints,
        destinationName: this.destinationName,
        instruction: evalRes.activeStep.instruction,
        remainingDistanceMeters: evalRes.remainingDistanceMeters,
        displayMode: this.displayMode,
      };
      if (evalRes.isOffRoute) {
        triggerReroute = true;
      }
    }

    const sampleTimestampMs = Number.isFinite(pos.timestamp) ? pos.timestamp : receivedAtMs;
    const sentAtMs = this.clock();
    const msg = coordsToGpsMessage(pos.coords, {
      sampleTimestampMs,
      phoneReceivedAtMs: receivedAtMs,
      phoneSentAtMs: sentAtMs,
      phoneSessionId: this.sessionId,
      phoneSeq: this.phoneSeq,
      previousSample: this.previousSample,
      compassHeadingDegrees: this.compassHeadingDegrees,
      ...routeGuidanceOpts,
    });
    this.previousSample = { coords: pos.coords, timestamp: sampleTimestampMs };

    this.speedKmhText = msg.speedMps === null ? "--" : String(Math.round(msg.speedMps * 3.6));
    const srcTag = msg.speedSource === "derived" ? " (derived)" : "";
    const accText = msg.accuracyMeters === null ? "?" : String(Math.round(msg.accuracyMeters));
    this.lastFixSummary = `fix #${this.phoneSeq} | accuracy ${accText} m${srcTag} - ${msg.latitude.toFixed(5)}, ${msg.longitude.toFixed(5)}`;

    const payload = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WS_OPEN && this.wsState === "connected") {
      this.trySendPayload(this.ws, payload);
    } else {
      // Buffer only the single newest fix while connecting/reconnecting
      this.latestPendingPayload = payload;
    }

    if (triggerReroute) {
      this.onAutoRerouteRequested?.({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
    }

    this.notify();
  }

  private trySendPayload(socket: PhoneSocketLike, payload: string): void {
    try {
      socket.send(payload);
      this.packetsSent += 1;
      this.lastSentAtMs = this.clock();
      if (this.relayDisplays > 0) {
        this.packetsDeliveredToDisplay += 1;
      }
    } catch {
      this.latestPendingPayload = payload;
      this.errorMessage = "Relay WebSocket send failed — waiting to reconnect.";
    }
  }

  private handleGeoError(err: { code: number; message?: string }): void {
    this.gpsState = "error";
    this.errorMessage = describeGeoError(err.code);
    this.notify();
  }

  private computeStatusLabel(): string {
    if (!this.running) return "Stopped";
    if (this.gpsState === "error") return "GPS error";
    if (this.wsState === "connecting") return "Connecting";
    if (this.wsState === "reconnecting") return "Reconnecting";
    if (this.wsState === "disconnected" || this.wsState === "error") return "Relay disconnected";
    if (this.gpsState === "permission_required") return "GPS permission required";
    if (this.gpsState === "waiting_for_fix") return "Waiting for GPS fix";
    if (this.packetsSent > 0 && this.relayDisplays > 0) return "Sending GPS";
    if (this.gpsState === "active") return "GPS active";
    return "Relay connected";
  }

  private computeLinkLabel(): string {
    if (!this.running) {
      return "Link status: stopped";
    }
    if (this.wsState === "connecting") {
      return `Relay: connecting to ${this.sanitizedEndpoint}...`;
    }
    if (this.wsState === "reconnecting") {
      return `Relay: reconnecting to ${this.sanitizedEndpoint}...`;
    }
    if (this.wsState === "disconnected" || this.wsState === "error") {
      return `Relay disconnected (${this.sanitizedEndpoint})`;
    }
    // wsState === "connected"
    if (this.relayDisplays === 0) {
      return `Relay connected (0 PC displays on this relay — open ${this.sanitizedEndpoint.replace(/^ws/, "http").replace(/\/ws\?.*$/, "")} on PC and select Live phone GPS)`;
    }
    if (this.packetsSent > 0 && this.packetsDeliveredToDisplay > 0) {
      return `Sending GPS — Relay connected (${this.relayDisplays} PC display linked, ${this.packetsSent} sent)`;
    }
    return `Relay connected (${this.relayDisplays} PC display linked — waiting for GPS fix)`;
  }

  private computeInfoLabel(): string {
    if (!this.running) {
      return "waiting for GPS...";
    }
    if (this.gpsState === "permission_required") {
      return "GPS permission required — allow location access in Safari.";
    }
    if (this.gpsState === "waiting_for_fix") {
      return "Waiting for GPS fix...";
    }
    if (this.gpsState === "error") {
      return "GPS error — no location fix available.";
    }
    const deliveryNote =
      this.wsState !== "connected"
        ? "not sent (relay disconnected)"
        : this.relayDisplays === 0
          ? `sent to relay #${this.packetsSent} (no PC display linked)`
          : `sent #${this.packetsSent} (delivered to PC display)`;
    return `${this.lastFixSummary} | ${deliveryNote}`;
  }

  private notify(): void {
    this.onChange?.(this.getSnapshot());
  }
}
