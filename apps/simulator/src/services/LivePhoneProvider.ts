import {
  DEFAULT_LIVE_GPS_CONFIG,
  NAVIGATION_MODES,
  PROTOCOL_VERSION,
  ROUTE_STATUSES,
  TURN_DIRECTIONS,
  buildLiveNavigationData,
  systemClock,
  validateGpsFix,
  type Clock,
  type DisplaySocketState,
  type GpsFixMessage,
  type LiveDiagnosticStatus,
  type LiveGpsState,
  type LiveLatencyMetrics,
  type NavigationData,
  type NavigationMode,
  type NavigationPacket,
  type RoutePoint,
  type RouteStatus,
  type TurnDirection,
} from "@w-map/navigation-core";
import type { NavigationDataProvider } from "./NavigationDataProvider";

/** Minimal WebSocket surface used here, so tests can inject a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  send?(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export type LiveOverlayPatch = Partial<
  Pick<
    NavigationData,
    "turnDirection" | "distanceToTurnMeters" | "routeStatus" | "routePoints" | "speedLimitKmh" | "speedLimitStatus"
  >
>;

export interface LivePhoneOptions {
  url: string;
  clock?: Clock;
  socketFactory?: SocketFactory;
  /** Re-emit period so freshness is re-evaluated even when no fix arrives. 0 disables. */
  heartbeatMs?: number;
  /** Base reconnect delay in ms. 0 disables automatic reconnect (tests). */
  reconnectMs?: number;
  /** Maximum reconnect backoff delay in ms. */
  maxReconnectMs?: number;
  /** Interval for sending WebSocket RTT echo pings to the relay. 0 disables. */
  pingIntervalMs?: number;
  /** Optional random source in [0, 1) for reconnect jitter (deterministic in tests). */
  random?: () => number;
}

/**
 * Builds the canonical WebSocket relay URL for a given browser location and role.
 * Never hardcodes localhost so iPhone Safari and PC browsers connect to their active origin.
 */
export function buildRelayWebSocketUrl(
  loc: Pick<Location, "protocol" | "host">,
  role: "phone" | "display",
): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const host = loc.host || "localhost:5173";
  return `${proto}://${host}/ws?role=${role}`;
}

/** Strips query credentials/tokens (if any) while preserving scheme, host, port, path, and role. */
export function sanitizeRelayEndpoint(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const role = u.searchParams.get("role");
    return `${u.protocol}//${u.host}${u.pathname}${role ? `?role=${role}` : ""}`;
  } catch {
    return rawUrl;
  }
}

/** Bounded exponential backoff with +-15% jitter. */
export function computeReconnectDelayMs(
  attempt: number,
  baseMs: number,
  maxMs = 15_000,
  random: () => number = Math.random,
): number {
  if (baseMs <= 0) return 0;
  const exp = Math.min(maxMs, baseMs * Math.pow(1.8, Math.max(0, attempt)));
  const jitterFactor = 0.85 + Math.min(1, Math.max(0, random())) * 0.3;
  return Math.min(maxMs, Math.max(baseMs, Math.round(exp * jitterFactor)));
}

const INITIAL_METRICS: LiveLatencyMetrics = {
  phoneSampleAgeMs: null,
  phoneProcessingDelayMs: null,
  relayToSimulatorMs: null,
  simulatorProcessingMs: null,
  timeSinceLastFixMs: null,
  timeSinceLastPacketMs: null,
  roundTripPingMs: null,
  updateFrequencyHz: 0,
  acceptedFixes: 0,
  invalidMessages: 0,
  droppedOutOfOrder: 0,
  speedSource: "none",
  displaySocketState: "disconnected",
  relayPhoneCount: 0,
  relayEndpoint: "",
  lastPhoneSendAtMs: null,
  lastError: null,
  diagnosticStatus: "DISCONNECTED_FROM_RELAY",
  diagnosticSummary: "Not connected to relay.",
};

/**
 * Real GPS from a phone page via the local WebSocket relay (WiFi/LAN). This is NOT Bluetooth.
 * Validates each fix, tracks sender session/sequence numbers, and records measurable latency metrics.
 */
export class LivePhoneProvider implements NavigationDataProvider {
  readonly id = "live-phone-gps";
  readonly label = "LIVE phone GPS (WiFi relay, not BLE)";
  readonly isSimulated = false;

  private state: LiveGpsState = { fix: null, fixReceivedAtMs: null, linkConnected: false };
  private overlay: LiveOverlayPatch = {};
  private phoneOverlay: LiveOverlayPatch = {};
  private phoneDestinationName: string | null = null;
  private phoneInstruction: string | null = null;
  private phoneRemainingDistanceMeters: number | null = null;
  private phoneDisplayMode: NavigationMode | null = null;
  private socketOpen = false;
  private displaySocketState: DisplaySocketState = "disconnected";
  private phones = 0;
  private sequence = 0;
  private socket: SocketLike | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private readonly listeners = new Set<(raw: string) => void>();
  private readonly metricListeners = new Set<() => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private readonly clock: Clock;
  private readonly factory: SocketFactory;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly pingIntervalMs: number;
  private readonly random: () => number;
  private readonly sanitizedEndpoint: string;

  // Sender session & sequence tracking
  private lastPhoneSessionId: string | null = null;
  private lastPhoneSeq: number | null = null;
  private lastSampleTimestampMs: number | null = null;

  // Latency & telemetry counters
  invalidMessages = 0;
  droppedOutOfOrder = 0;
  acceptedFixes = 0;
  private lastPacketReceivedAtMs: number | null = null;
  private readonly fixArrivalTimesMs: number[] = [];
  private metricsSnapshot: LiveLatencyMetrics;

  constructor(private readonly options: LivePhoneOptions) {
    this.clock = options.clock ?? systemClock;
    this.factory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.reconnectMs = options.reconnectMs ?? 1500;
    this.maxReconnectMs = options.maxReconnectMs ?? 15_000;
    this.pingIntervalMs = options.pingIntervalMs ?? (this.heartbeatMs > 0 ? 2000 : 0);
    this.random = options.random ?? Math.random;
    this.sanitizedEndpoint = sanitizeRelayEndpoint(options.url);
    this.metricsSnapshot = {
      ...INITIAL_METRICS,
      relayEndpoint: this.sanitizedEndpoint,
    };
  }

  subscribe(listener: (rawMessage: string) => void): () => void {
    this.listeners.add(listener);
    if (this.socket === null) this.connect();
    if (this.heartbeat === null && this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        this.refreshMetrics(null, null, null);
        this.emit();
      }, this.heartbeatMs);
    }
    if (this.pingTimer === null && this.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs);
    }
    listener(this.build());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.teardown();
    };
  }

  subscribeMetrics = (listener: () => void): (() => void) => {
    this.metricListeners.add(listener);
    return () => {
      this.metricListeners.delete(listener);
    };
  };

  getMetrics = (): LiveLatencyMetrics => this.metricsSnapshot;

  getLatestFix(): GpsFixMessage | null {
    return this.state.fix;
  }

  /**
   * Apply or clear active route guidance overlay on top of live GPS telemetry.
   * Does not alter raw GPS coordinates, speed, or speed-limit rules.
   */
  setRouteOverlay(patch: LiveOverlayPatch): void {
    this.overlay = { ...patch };
    if (this.listeners.size > 0) {
      this.emit();
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.metricListeners.clear();
    this.teardown();
  }

  sendPing(): void {
    if (this.socket && this.socketOpen && typeof this.socket.send === "function") {
      try {
        this.socket.send(JSON.stringify({ type: "ping", sentAtMs: this.clock.nowMs() }));
      } catch {
        // Ignore send errors on closing sockets
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnect !== null) {
      clearTimeout(this.reconnect);
      this.reconnect = null;
    }
  }

  private detachAndCloseSocket(): void {
    const s = this.socket;
    this.socket = null;
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

  private connect(): void {
    this.clearReconnectTimer();
    this.detachAndCloseSocket();

    this.displaySocketState = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    this.refreshMetrics(null, null, null);

    let socket: SocketLike;
    try {
      socket = this.factory(this.options.url);
    } catch (err) {
      this.socketOpen = false;
      this.displaySocketState = "error";
      this.lastError = err instanceof Error ? err.message : `Failed to open WebSocket to ${this.sanitizedEndpoint}`;
      this.updateLink();
      this.refreshMetrics(null, null, null);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.socketOpen = true;
      this.reconnectAttempts = 0;
      this.displaySocketState = "connected";
      this.lastError = null;
      this.updateLink();
      this.refreshMetrics(null, null, null);
      this.sendPing();
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socketOpen = false;
      this.phones = 0;
      this.socket = null;
      this.metricsSnapshot = { ...this.metricsSnapshot, roundTripPingMs: null };
      const willReconnect = this.listeners.size > 0 && this.reconnectMs > 0;
      this.displaySocketState = willReconnect ? "reconnecting" : "disconnected";
      if (!this.lastError) {
        this.lastError = `Disconnected from relay (${this.sanitizedEndpoint}).`;
      }
      this.updateLink();
      this.refreshMetrics(null, null, null);
      if (willReconnect) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.displaySocketState = "error";
      this.lastError = `WebSocket error connecting to ${this.sanitizedEndpoint}. Ensure npm run dev:phone is running and both devices use the same HTTPS server.`;
      this.refreshMetrics(null, null, null);
      socket.close();
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handle(ev.data);
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (this.listeners.size === 0 || this.reconnectMs <= 0) return;
    const delayMs = computeReconnectDelayMs(
      this.reconnectAttempts,
      this.reconnectMs,
      this.maxReconnectMs,
      this.random,
    );
    this.reconnectAttempts += 1;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      if (this.listeners.size > 0 && this.socket === null) {
        this.connect();
      }
    }, delayMs);
  }

  private applyPhonePresenceCount(phones: unknown): void {
    const nextPhones = typeof phones === "number" && Number.isFinite(phones) && phones >= 0 ? Math.floor(phones) : 0;
    if (nextPhones === 0 && this.phones > 0) {
      // Phone disconnected; reset sender sequence gate so reconnect starts cleanly
      this.lastPhoneSessionId = null;
      this.lastPhoneSeq = null;
      this.lastSampleTimestampMs = null;
      this.phoneOverlay = {};
      this.phoneDestinationName = null;
      this.phoneInstruction = null;
      this.phoneRemainingDistanceMeters = null;
      this.phoneDisplayMode = null;
    } else if (nextPhones === 0) {
      this.lastPhoneSessionId = null;
      this.lastPhoneSeq = null;
      this.lastSampleTimestampMs = null;
      this.phoneOverlay = {};
      this.phoneDestinationName = null;
      this.phoneInstruction = null;
      this.phoneRemainingDistanceMeters = null;
      this.phoneDisplayMode = null;
    }
    if (this.phones !== nextPhones) {
      this.phones = nextPhones;
      this.updateLink();
    }
  }

  private handle(raw: unknown): void {
    const simReceivedAtMs = this.clock.nowMs();

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.lastPacketReceivedAtMs = simReceivedAtMs;
      this.invalidMessages += 1;
      this.lastError = "Malformed non-JSON message received from relay.";
      this.refreshMetrics(null, null, null);
      return;
    }

    const obj = parsed as { type?: unknown; phones?: unknown; sentAtMs?: unknown } | null;

    // Control message: presence update (does NOT count as a GPS packet arrival)
    if (obj?.type === "presence") {
      this.applyPhonePresenceCount(obj.phones);
      this.refreshMetrics(null, null, null);
      return;
    }

    // Control message: RTT pong (does NOT count as a GPS packet arrival)
    if (obj?.type === "pong" && typeof obj.sentAtMs === "number") {
      if (obj.phones !== undefined) {
        this.applyPhonePresenceCount(obj.phones);
      }
      const rtt = Math.max(0, simReceivedAtMs - obj.sentAtMs);
      this.metricsSnapshot = { ...this.metricsSnapshot, roundTripPingMs: rtt };
      this.refreshMetrics(null, null, null);
      return;
    }

    // Phone-computed route & display mode update ("Phone as Brain" SteedPilot mode)
    if (obj?.type === "phone_guidance") {
      this.applyPhoneGuidanceMessage(obj as Record<string, unknown>);
      this.emit();
      this.refreshMetrics(null, null, null);
      return;
    }

    // From this point on, the message is a GPS data packet candidate
    this.lastPacketReceivedAtMs = simReceivedAtMs;

    const fixRes = validateGpsFix(parsed);
    if (!fixRes.ok) {
      this.invalidMessages += 1;
      this.lastError = `Rejected invalid GPS packet: ${fixRes.errors.join(", ")}`;
      this.refreshMetrics(null, null, null);
      return;
    }
    const fix = fixRes.value;

    // Sender session & sequence validation:
    // - If phoneSessionId changed (phone restarted watcher), reset lastPhoneSeq and lastSampleTimestampMs.
    // - Within the same session, reject duplicate or older phoneSeq values, and reject older sampleTimestampMs.
    if (fix.phoneSessionId !== undefined && fix.phoneSessionId !== null) {
      if (this.lastPhoneSessionId !== fix.phoneSessionId) {
        this.lastPhoneSessionId = fix.phoneSessionId;
        this.lastPhoneSeq = null;
        this.lastSampleTimestampMs = null;
      }
    }
    if (fix.phoneSeq !== undefined && fix.phoneSeq !== null) {
      if (this.lastPhoneSeq !== null && fix.phoneSeq <= this.lastPhoneSeq) {
        this.droppedOutOfOrder += 1;
        this.lastError = `Dropped out-of-order or duplicate GPS packet (seq #${fix.phoneSeq} <= #${this.lastPhoneSeq}).`;
        this.refreshMetrics(null, null, null);
        return;
      }
    }
    if (fix.sampleTimestampMs !== undefined && fix.sampleTimestampMs !== null) {
      if (this.lastSampleTimestampMs !== null && fix.sampleTimestampMs < this.lastSampleTimestampMs) {
        this.droppedOutOfOrder += 1;
        this.lastError = `Dropped older GPS sample timestamp (${fix.sampleTimestampMs} < ${this.lastSampleTimestampMs}).`;
        this.refreshMetrics(null, null, null);
        return;
      }
    }

    if (fix.phoneSeq !== undefined && fix.phoneSeq !== null) {
      this.lastPhoneSeq = fix.phoneSeq;
    }
    if (fix.sampleTimestampMs !== undefined && fix.sampleTimestampMs !== null) {
      this.lastSampleTimestampMs = fix.sampleTimestampMs;
    }

    this.acceptedFixes += 1;
    this.lastError = null;
    this.applyPhoneGuidanceFromFix(fix);
    this.state = { ...this.state, fix, fixReceivedAtMs: simReceivedAtMs };

    // Record arrival in a 5-second rolling window for frequency calculation
    this.fixArrivalTimesMs.push(simReceivedAtMs);
    while (this.fixArrivalTimesMs.length > 0 && simReceivedAtMs - this.fixArrivalTimesMs[0]! > 5000) {
      this.fixArrivalTimesMs.shift();
    }

    this.emit();
    const simDoneAtMs = this.clock.nowMs();
    this.refreshMetrics(fix, simReceivedAtMs, Math.max(0, simDoneAtMs - simReceivedAtMs));
  }

  private computeDiagnostics(now: number): { status: LiveDiagnosticStatus; summary: string } {
    if (!this.socketOpen) {
      return {
        status: "DISCONNECTED_FROM_RELAY",
        summary:
          this.displaySocketState === "reconnecting"
            ? `Reconnecting to relay (${this.sanitizedEndpoint})...`
            : `Display WebSocket disconnected from relay (${this.sanitizedEndpoint}).`,
      };
    }
    if (this.phones <= 0) {
      return {
        status: "PHONE_ABSENT_FROM_RELAY",
        summary:
          "Relay connected, but 0 phones are registered on this relay. Ensure iPhone and PC use the exact same https://<LAN-IP>:5173 server and tap Start on the phone.",
      };
    }
    if (this.acceptedFixes === 0) {
      if (this.invalidMessages > 0 || this.droppedOutOfOrder > 0) {
        return {
          status: "GPS_PACKET_REJECTED",
          summary: `Phone connected, but all received packets were rejected (${this.invalidMessages} invalid, ${this.droppedOutOfOrder} out-of-order).`,
        };
      }
      return {
        status: "TRANSPORT_CONNECTED_NO_GPS",
        summary: "Transport connected & phone registered on relay — waiting for first valid GPS fix from iPhone.",
      };
    }

    const fix = this.state.fix;
    const fixReceivedAtMs = this.state.fixReceivedAtMs;
    const receiverAgeMs = fixReceivedAtMs !== null ? Math.max(0, now - fixReceivedAtMs) : Infinity;
    const phoneSampleAgeMs =
      fix !== null && fix.phoneReceivedAtMs != null && fix.sampleTimestampMs != null
        ? Math.max(0, fix.phoneReceivedAtMs - fix.sampleTimestampMs)
        : 0;
    const isFresh =
      fix !== null &&
      fixReceivedAtMs !== null &&
      receiverAgeMs <= DEFAULT_LIVE_GPS_CONFIG.gpsTimeoutMs &&
      receiverAgeMs + phoneSampleAgeMs <= DEFAULT_LIVE_GPS_CONFIG.gpsTimeoutMs &&
      (fix.accuracyMeters === null || fix.accuracyMeters <= DEFAULT_LIVE_GPS_CONFIG.maxAccuracyMeters);

    if (!isFresh) {
      return {
        status: "GPS_DATA_STALE",
        summary: "GPS data stale or accuracy > 100 m — no fresh GPS fix within 3 s timeout.",
      };
    }

    return {
      status: "HEALTHY_LIVE_GPS",
      summary: `Healthy live GPS flow (${this.phones} phone linked, ${this.acceptedFixes} fixes accepted).`,
    };
  }

  private refreshMetrics(
    latestFix: GpsFixMessage | null,
    simReceivedAtMs: number | null,
    simProcMs: number | null,
  ): void {
    const now = this.clock.nowMs();
    const fix = latestFix ?? this.state.fix;

    let phoneSampleAgeMs = this.metricsSnapshot.phoneSampleAgeMs;
    let phoneProcessingDelayMs = this.metricsSnapshot.phoneProcessingDelayMs;
    let relayToSimulatorMs = this.metricsSnapshot.relayToSimulatorMs;
    let simulatorProcessingMs = this.metricsSnapshot.simulatorProcessingMs;
    let lastPhoneSendAtMs = this.metricsSnapshot.lastPhoneSendAtMs ?? null;

    if (latestFix) {
      phoneSampleAgeMs =
        latestFix.phoneReceivedAtMs != null && latestFix.sampleTimestampMs != null
          ? Math.max(0, latestFix.phoneReceivedAtMs - latestFix.sampleTimestampMs)
          : null;
      phoneProcessingDelayMs =
        latestFix.phoneSentAtMs != null && latestFix.phoneReceivedAtMs != null
          ? Math.max(0, latestFix.phoneSentAtMs - latestFix.phoneReceivedAtMs)
          : null;
      relayToSimulatorMs =
        simReceivedAtMs != null && latestFix.relayReceivedAtMs != null
          ? Math.max(0, simReceivedAtMs - latestFix.relayReceivedAtMs)
          : null;
      simulatorProcessingMs = simProcMs;
      if (latestFix.phoneSentAtMs != null) {
        lastPhoneSendAtMs = latestFix.phoneSentAtMs;
      }
    }

    // Prune arrivals older than 5 seconds
    while (this.fixArrivalTimesMs.length > 0 && now - this.fixArrivalTimesMs[0]! > 5000) {
      this.fixArrivalTimesMs.shift();
    }
    let updateFrequencyHz = 0;
    if (this.fixArrivalTimesMs.length >= 2) {
      const spanMs = this.fixArrivalTimesMs.at(-1)! - this.fixArrivalTimesMs[0]!;
      updateFrequencyHz = spanMs > 0 ? Number((((this.fixArrivalTimesMs.length - 1) * 1000) / spanMs).toFixed(2)) : 0;
    } else if (this.fixArrivalTimesMs.length === 1) {
      updateFrequencyHz = 0.2;
    }

    const diag = this.computeDiagnostics(now);

    this.metricsSnapshot = {
      phoneSampleAgeMs,
      phoneProcessingDelayMs,
      relayToSimulatorMs,
      simulatorProcessingMs,
      timeSinceLastFixMs: this.state.fixReceivedAtMs !== null ? Math.max(0, now - this.state.fixReceivedAtMs) : null,
      timeSinceLastPacketMs:
        this.lastPacketReceivedAtMs !== null ? Math.max(0, now - this.lastPacketReceivedAtMs) : null,
      roundTripPingMs: this.metricsSnapshot.roundTripPingMs,
      updateFrequencyHz,
      acceptedFixes: this.acceptedFixes,
      invalidMessages: this.invalidMessages,
      droppedOutOfOrder: this.droppedOutOfOrder,
      speedSource: fix?.speedSource ?? (fix?.speedMps != null ? "native" : "none"),
      displaySocketState: this.displaySocketState,
      relayPhoneCount: this.phones,
      relayEndpoint: this.sanitizedEndpoint,
      lastPhoneSendAtMs,
      lastError: this.lastError,
      diagnosticStatus: diag.status,
      diagnosticSummary: diag.summary,
      phoneDestinationName: this.phoneDestinationName,
      phoneInstruction: this.phoneInstruction,
      phoneRemainingDistanceMeters: this.phoneRemainingDistanceMeters,
      phoneDisplayMode: this.phoneDisplayMode,
    };
    this.notifyMetrics();
  }

  private applyPhoneGuidanceFromFix(fix: GpsFixMessage): void {
    if (fix.routeStatus !== undefined) {
      this.phoneOverlay = {
        routeStatus: fix.routeStatus,
        turnDirection: fix.turnDirection ?? "STRAIGHT",
        distanceToTurnMeters: fix.distanceToTurnMeters ?? null,
        routePoints: fix.routePoints ?? [],
        speedLimitKmh: null,
        speedLimitStatus: "UNKNOWN",
      };
    }
    if (fix.destinationName !== undefined) this.phoneDestinationName = fix.destinationName;
    if (fix.instruction !== undefined) this.phoneInstruction = fix.instruction;
    if (fix.remainingDistanceMeters !== undefined) {
      this.phoneRemainingDistanceMeters = fix.remainingDistanceMeters;
    }
    if (fix.displayMode !== undefined) this.phoneDisplayMode = fix.displayMode;
  }

  private applyPhoneGuidanceMessage(msg: Record<string, unknown>): void {
    const routeStatus = (ROUTE_STATUSES as readonly unknown[]).includes(msg.routeStatus)
      ? (msg.routeStatus as RouteStatus)
      : undefined;
    const turnDirection = (TURN_DIRECTIONS as readonly unknown[]).includes(msg.turnDirection)
      ? (msg.turnDirection as TurnDirection)
      : "STRAIGHT";
    const distanceToTurnMeters =
      typeof msg.distanceToTurnMeters === "number" && Number.isFinite(msg.distanceToTurnMeters) && msg.distanceToTurnMeters >= 0
        ? msg.distanceToTurnMeters
        : null;
    const routePoints: RoutePoint[] = [];
    if (Array.isArray(msg.routePoints) && msg.routePoints.length <= 64) {
      for (const pt of msg.routePoints) {
        if (
          typeof pt === "object" &&
          pt !== null &&
          typeof (pt as Record<string, unknown>).latitude === "number" &&
          typeof (pt as Record<string, unknown>).longitude === "number"
        ) {
          routePoints.push({
            latitude: (pt as Record<string, unknown>).latitude as number,
            longitude: (pt as Record<string, unknown>).longitude as number,
          });
        }
      }
    }
    if (routeStatus !== undefined) {
      this.phoneOverlay = {
        routeStatus,
        turnDirection,
        distanceToTurnMeters,
        routePoints,
        speedLimitKmh: null,
        speedLimitStatus: "UNKNOWN",
      };
    }
    if (typeof msg.destinationName === "string" || msg.destinationName === null) {
      this.phoneDestinationName = msg.destinationName as string | null;
    }
    if (typeof msg.instruction === "string" || msg.instruction === null) {
      this.phoneInstruction = msg.instruction as string | null;
    }
    if (typeof msg.remainingDistanceMeters === "number" || msg.remainingDistanceMeters === null) {
      this.phoneRemainingDistanceMeters = msg.remainingDistanceMeters as number | null;
    }
    if ((NAVIGATION_MODES as readonly unknown[]).includes(msg.displayMode)) {
      this.phoneDisplayMode = msg.displayMode as NavigationMode;
    }
  }

  private notifyMetrics(): void {
    this.metricListeners.forEach((l) => l());
  }

  private updateLink(): void {
    this.state = { ...this.state, linkConnected: this.socketOpen && this.phones > 0 };
    this.emit();
  }

  private emit(): void {
    const msg = this.build();
    this.listeners.forEach((l) => l(msg));
  }

  /** Re-emit the current state (what the heartbeat timer does); exposed so tests need no timers. */
  emitCurrentForTest(): void {
    this.refreshMetrics(null, null, null);
    this.emit();
  }

  private build(): string {
    this.sequence += 1;
    const baseData = buildLiveNavigationData(this.state, this.clock.nowMs(), this.sequence);
    const data: NavigationData = {
      ...baseData,
      ...this.phoneOverlay,
      ...this.overlay,
    };
    const packet: NavigationPacket = {
      version: PROTOCOL_VERSION,
      data,
    };
    return JSON.stringify(packet);
  }

  private teardown(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearReconnectTimer();
    this.detachAndCloseSocket();
    this.socketOpen = false;
    this.displaySocketState = "disconnected";
    this.phones = 0;
  }
}
