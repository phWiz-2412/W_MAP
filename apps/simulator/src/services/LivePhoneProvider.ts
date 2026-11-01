import {
  PROTOCOL_VERSION,
  buildLiveNavigationData,
  systemClock,
  validateGpsFix,
  type Clock,
  type GpsFixMessage,
  type LiveGpsState,
  type LiveLatencyMetrics,
  type NavigationData,
  type NavigationPacket,
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
  /** Reconnect delay. 0 disables (tests). */
  reconnectMs?: number;
  /** Interval for sending WebSocket RTT echo pings to the relay. 0 disables. */
  pingIntervalMs?: number;
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
  private socketOpen = false;
  private phones = 0;
  private sequence = 0;
  private socket: SocketLike | null = null;
  private readonly listeners = new Set<(raw: string) => void>();
  private readonly metricListeners = new Set<() => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private readonly clock: Clock;
  private readonly factory: SocketFactory;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly pingIntervalMs: number;

  // Sender session & sequence tracking
  private lastPhoneSessionId: string | null = null;
  private lastPhoneSeq: number | null = null;

  // Latency & telemetry counters
  invalidMessages = 0;
  droppedOutOfOrder = 0;
  acceptedFixes = 0;
  private lastPacketReceivedAtMs: number | null = null;
  private readonly fixArrivalTimesMs: number[] = [];
  private metricsSnapshot: LiveLatencyMetrics = { ...INITIAL_METRICS };

  constructor(private readonly options: LivePhoneOptions) {
    this.clock = options.clock ?? systemClock;
    this.factory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.reconnectMs = options.reconnectMs ?? 1500;
    this.pingIntervalMs = options.pingIntervalMs ?? (this.heartbeatMs > 0 ? 2000 : 0);
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

  private connect(): void {
    const socket = this.factory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.socketOpen = true;
      this.updateLink();
      this.sendPing();
    };
    socket.onclose = () => {
      this.socketOpen = false;
      this.phones = 0;
      this.socket = null;
      this.updateLink();
      if (this.listeners.size > 0 && this.reconnectMs > 0) {
        this.reconnect = setTimeout(() => this.connect(), this.reconnectMs);
      }
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (ev) => this.handle(ev.data);
  }

  private handle(raw: unknown): void {
    const simReceivedAtMs = this.clock.nowMs();
    this.lastPacketReceivedAtMs = simReceivedAtMs;

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.invalidMessages += 1;
      this.refreshMetrics(null, null, null);
      return;
    }
    const obj = parsed as { type?: unknown; phones?: unknown; sentAtMs?: unknown } | null;
    if (obj?.type === "presence") {
      const phones = obj.phones;
      const nextPhones = typeof phones === "number" && phones >= 0 ? phones : 0;
      if (nextPhones === 0) {
        // Phone disconnected; reset sender sequence gate so reconnect starts cleanly
        this.lastPhoneSessionId = null;
        this.lastPhoneSeq = null;
      }
      this.phones = nextPhones;
      this.updateLink();
      this.refreshMetrics(null, null, null);
      return;
    }
    if (obj?.type === "pong" && typeof obj.sentAtMs === "number") {
      const rtt = Math.max(0, simReceivedAtMs - obj.sentAtMs);
      this.metricsSnapshot = { ...this.metricsSnapshot, roundTripPingMs: rtt };
      this.notifyMetrics();
      return;
    }

    const fixRes = validateGpsFix(parsed);
    if (!fixRes.ok) {
      this.invalidMessages += 1;
      this.refreshMetrics(null, null, null);
      return;
    }
    const fix = fixRes.value;

    // Sender session & sequence validation:
    // - If phoneSessionId changed (phone restarted watcher), reset lastPhoneSeq and accept.
    // - Within the same session, reject duplicate or older phoneSeq values.
    if (fix.phoneSessionId !== undefined && fix.phoneSessionId !== null) {
      if (this.lastPhoneSessionId !== fix.phoneSessionId) {
        this.lastPhoneSessionId = fix.phoneSessionId;
        this.lastPhoneSeq = null;
      }
    }
    if (fix.phoneSeq !== undefined && fix.phoneSeq !== null) {
      if (this.lastPhoneSeq !== null && fix.phoneSeq <= this.lastPhoneSeq) {
        this.droppedOutOfOrder += 1;
        this.refreshMetrics(null, null, null);
        return;
      }
      this.lastPhoneSeq = fix.phoneSeq;
    }

    this.acceptedFixes += 1;
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
    };
    this.notifyMetrics();
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
    if (this.reconnect !== null) clearTimeout(this.reconnect);
    this.reconnect = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.socketOpen = false;
  }
}
